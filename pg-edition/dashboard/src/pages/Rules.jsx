import { useState } from 'react';
import { api } from '../api.js';
import { fmtDuration, useApi } from '../util.js';
import { CategoryBadge, Loading, useCanWrite, useToast } from '../components/ui.jsx';

function Classify({ onPick, disabled }) {
  return (
    <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
      <button className="sm" disabled={disabled} onClick={() => onPick(1)} title="Productive">✓</button>
      <button className="sm" disabled={disabled} onClick={() => onPick(0)} title="Neutral">–</button>
      <button className="sm" disabled={disabled} onClick={() => onPick(-1)} title="Unproductive">✕</button>
    </span>
  );
}

export default function Rules() {
  const rules = useApi('/settings/rules');
  const unclassified = useApi('/analytics/unclassified');
  const canWrite = useCanWrite();
  const toast = useToast();
  const [form, setForm] = useState({ kind: 'domain', pattern: '', category: 1 });
  const [filter, setFilter] = useState('');

  const add = async (items) => {
    try {
      const r = await api('/settings/rules', { method: 'POST', body: items });
      rules.setData(r);
      unclassified.reload();
    } catch (e) { toast(e, 'error'); }
  };
  const remove = async (id) => rules.setData(await api(`/settings/rules/${id}`, { method: 'DELETE' }));

  const list = (rules.data || []).filter((r) => !filter || r.pattern.toLowerCase().includes(filter.toLowerCase()));

  return (
    <>
      <div className="page-head">
        <div><h1>Productivity rules</h1><div className="sub">Classify apps and websites. Applied instantly to all reports, including past data.</div></div>
      </div>
      <div className="grid cols-2">
        <div className="card flush">
          <div style={{ padding: 16 }} className="stack">
            {canWrite && (
              <form className="row" onSubmit={(e) => { e.preventDefault(); add([form]); setForm({ ...form, pattern: '' }); }}>
                <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  <option value="domain">Website</option><option value="app">Application</option>
                </select>
                <input required placeholder={form.kind === 'domain' ? 'e.g. github.com' : 'e.g. Photoshop'} value={form.pattern}
                  onChange={(e) => setForm({ ...form, pattern: e.target.value })} style={{ flex: 1, minWidth: 140 }} />
                <select value={form.category} onChange={(e) => setForm({ ...form, category: Number(e.target.value) })}>
                  <option value={1}>Productive</option><option value={0}>Neutral</option><option value={-1}>Unproductive</option>
                </select>
                <button className="primary">Add</button>
              </form>
            )}
            <input placeholder="Search rules…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="muted small">Website rules also match subdomains (google.com matches mail.google.com). App rules match any app whose name contains the text.</div>
          </div>
          {!rules.data ? <Loading /> : (
            <div className="table-wrap" style={{ maxHeight: 560, overflowY: 'auto' }}>
              <table>
                <thead><tr><th>Type</th><th>Pattern</th><th>Category</th><th /></tr></thead>
                <tbody>
                  {list.map((r) => (
                    <tr key={r.id}>
                      <td className="muted">{r.kind === 'domain' ? 'Website' : 'App'}</td>
                      <td><b>{r.pattern}</b></td>
                      <td><CategoryBadge category={r.category} /></td>
                      <td className="num">{canWrite && <button className="sm ghost danger" onClick={() => remove(r.id)}>Remove</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <h2>Needs classification</h2>
          <p className="muted small" style={{ marginTop: -6 }}>Most-used apps and websites from the last 14 days without a rule.</p>
          {!unclassified.data ? <Loading /> : (
            <div className="stack" style={{ gap: 6 }}>
              <h3 className="mt">Websites</h3>
              {unclassified.data.domains.length === 0 && <div className="muted small">All classified 🎉</div>}
              {unclassified.data.domains.slice(0, 20).map((d) => (
                <div key={d.name} className="row between">
                  <span>{d.name} <span className="muted small">{fmtDuration(d.seconds)}</span></span>
                  <Classify disabled={!canWrite} onPick={(c) => add([{ kind: 'domain', pattern: d.name, category: c }])} />
                </div>
              ))}
              <h3 className="mt">Applications</h3>
              {unclassified.data.apps.length === 0 && <div className="muted small">All classified 🎉</div>}
              {unclassified.data.apps.slice(0, 20).map((d) => (
                <div key={d.name} className="row between">
                  <span>{d.name} <span className="muted small">{fmtDuration(d.seconds)}</span></span>
                  <Classify disabled={!canWrite} onPick={(c) => add([{ kind: 'app', pattern: d.name, category: c }])} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
