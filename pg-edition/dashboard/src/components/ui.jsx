import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { CATEGORY, fmtDuration } from '../util.js';

// ---------- toasts ----------
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, type = 'info') => {
    const id = Math.random();
    setItems((x) => [...x, { id, msg: msg?.message || String(msg), type }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((t) => <div key={t.id} className={`toast ${t.type}`}>{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- auth ----------
export const AuthCtx = createContext({ admin: null });
export const useAuth = () => useContext(AuthCtx);
export const useCanWrite = () => useAuth().admin?.role === 'admin';

export function Modal({ title, children, onClose, actions, wide }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <h2>{title}</h2>
        {children}
        {actions && <div className="actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Stat({ label, value, hint }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Loading() {
  return <div className="empty"><span className="spin" /></div>;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="error-box">{error.message || String(error)}</div>;
}

export function CategoryBadge({ category }) {
  const c = CATEGORY[category] || CATEGORY[0];
  return <span className={`badge ${c.cls}`}>{c.label}</span>;
}

export function StatusDot({ device }) {
  const cls = device.online ? (device.paused ? 'paused' : 'on') : '';
  const label = device.status === 'disabled' ? 'Disabled' : device.online ? (device.paused ? 'Paused' : 'Online') : 'Offline';
  return <span className="row" style={{ gap: 6 }}><span className={`dot ${cls}`} />{label}</span>;
}

const catColor = { 1: 'var(--good)', 0: 'var(--neutral)', '-1': 'var(--bad)' };
export function BarList({ items, empty = 'No data yet' }) {
  if (!items?.length) return <div className="empty">{empty}</div>;
  const max = Math.max(...items.map((i) => i.seconds), 1);
  return (
    <div className="bar-list">
      {items.map((i) => (
        <div className="item" key={i.name}>
          <span className="name" title={i.name}>{i.name}</span>
          <span className="muted small">{fmtDuration(i.seconds)}</span>
          <div className="bar"><span style={{ width: `${(i.seconds / max) * 100}%`, background: catColor[i.category ?? 0] }} /></div>
        </div>
      ))}
    </div>
  );
}

export function ProductivityMeter({ productive = 0, neutral = 0, unproductive = 0 }) {
  const total = productive + neutral + unproductive || 1;
  return (
    <>
      <div className="meter">
        <span className="good" style={{ width: `${(productive / total) * 100}%` }} />
        <span className="neutral" style={{ width: `${(neutral / total) * 100}%` }} />
        <span className="bad" style={{ width: `${(unproductive / total) * 100}%` }} />
      </div>
      <div className="legend">
        <span><i style={{ background: 'var(--good)' }} />Productive {fmtDuration(productive)}</span>
        <span><i style={{ background: 'var(--neutral)', opacity: 0.55 }} />Neutral {fmtDuration(neutral)}</span>
        <span><i style={{ background: 'var(--bad)' }} />Unproductive {fmtDuration(unproductive)}</span>
      </div>
    </>
  );
}

/** 24-column hourly activity strip. */
export function HourStrip({ hours }) {
  const max = 3600;
  return (
    <>
      <div className="timeline">
        {hours.map((h) => (
          <div className="h" key={h.hour}
            title={`${String(h.hour).padStart(2, '0')}:00 — active ${fmtDuration(h.active)}, idle ${fmtDuration(h.idle)}${h.apps?.length ? `\n${h.apps.map((a) => `${a.domain || a.app}: ${fmtDuration(a.seconds)}`).join('\n')}` : ''}`}>
            <span style={{ height: `${Math.min(100, (h.active / max) * 100)}%`, background: 'var(--accent)' }} />
            <span style={{ height: `${Math.min(100, (h.idle / max) * 100)}%`, background: 'var(--idle)' }} />
          </div>
        ))}
      </div>
      <div className="timeline-axis">
        {hours.map((h) => <span key={h.hour}>{h.hour % 3 === 0 ? String(h.hour).padStart(2, '0') : ''}</span>)}
      </div>
    </>
  );
}

export function Confirm({ title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} actions={(
      <>
        <button onClick={onClose}>Cancel</button>
        <button className={danger ? 'danger solid' : 'primary'} disabled={busy}
          onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>
          {confirmLabel}
        </button>
      </>
    )}>
      <p className="muted">{message}</p>
    </Modal>
  );
}
