import { useEffect, useState } from 'react';
import { api, fileUrl } from '../api.js';
import { useOrg } from '../App.jsx';
import { fmtBytes, fmtDateTime, shiftDate, today } from '../util.js';
import { SubjectFilter, qs } from '../components/Filters.jsx';
import { ErrorBox, Loading, useCanWrite, useToast } from '../components/ui.jsx';

export function Lightbox({ items, index, onIndex, onClose, onDeleted }) {
  const org = useOrg();
  const canWrite = useCanWrite();
  const toast = useToast();
  const x = items[index];
  useEffect(() => {
    const k = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && index < items.length - 1) onIndex(index + 1);
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [index, items.length, onClose, onIndex]);
  if (!x) return null;
  return (
    <div className="lightbox" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <img src={fileUrl(x.url)} alt="" />
      <div className="bar">
        <button onClick={() => onIndex(index - 1)} disabled={index === 0}>‹ Prev</button>
        <span>
          <b>{x.employeeName || x.deviceName}</b> · {fmtDateTime(x.takenAt, org.timezone)} · {x.app || '—'}{x.domain ? ` · ${x.domain}` : ''} · {fmtBytes(x.bytes)}
        </span>
        <button onClick={() => onIndex(index + 1)} disabled={index >= items.length - 1}>Next ›</button>
        <a href={fileUrl(x.url)} target="_blank" rel="noreferrer"><button>Open</button></a>
        {canWrite && (
          <button onClick={async () => {
            await api(`/screenshots/${x.id}`, { method: 'DELETE' });
            toast('Screenshot deleted');
            onClose();
            onDeleted?.();
          }}>Delete</button>
        )}
        <button onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

export default function Screenshots() {
  const org = useOrg();
  const [date, setDate] = useState(today(org.timezone));
  const [subject, setSubject] = useState({ employeeId: '', deviceId: '' });
  const [app, setApp] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);

  const load = async (append = false) => {
    setLoading(true);
    setError(null);
    try {
      const before = append && items.length ? new Date(items.at(-1).takenAt).getTime() : undefined;
      const rows = await api(`/screenshots${qs({ date, employeeId: subject.employeeId, deviceId: subject.deviceId, app, limit: 48, before })}`);
      setItems(append ? [...items, ...rows] : rows);
      setDone(rows.length < 48);
    } catch (e) { setError(e); } finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(false); }, [date, subject.employeeId, subject.deviceId]);

  return (
    <>
      <div className="page-head">
        <div><h1>Screenshots</h1><div className="sub">{items.length} shown</div></div>
        <div className="row">
          <SubjectFilter value={subject} onChange={(v) => setSubject(v)} />
          <form onSubmit={(e) => { e.preventDefault(); load(false); }}>
            <input placeholder="Filter by app / site" value={app} onChange={(e) => setApp(e.target.value)} />
          </form>
          <button className="sm" onClick={() => setDate(shiftDate(date, -1))}>‹</button>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="sm" onClick={() => setDate(shiftDate(date, 1))}>›</button>
        </div>
      </div>
      <ErrorBox error={error} />
      {items.length === 0 && !loading ? <div className="card empty">No screenshots for this day</div> : (
        <div className="shots">
          {items.map((x, i) => (
            <div key={x.id} className="shot" onClick={() => setOpen(i)}>
              <img src={fileUrl(x.url)} alt="" loading="lazy" />
              <div className="meta">
                <b>{x.employeeName || x.deviceName}</b>
                <span className="muted">{new Date(x.takenAt).toLocaleTimeString([], { timeZone: org.timezone, hour: '2-digit', minute: '2-digit' })} · {x.domain || x.app || '—'}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {loading && <Loading />}
      {!done && items.length > 0 && !loading && (
        <div className="row mt" style={{ justifyContent: 'center' }}><button onClick={() => load(true)}>Load more</button></div>
      )}
      {open !== null && <Lightbox items={items} index={open} onIndex={setOpen} onClose={() => setOpen(null)} onDeleted={() => load(false)} />}
    </>
  );
}
