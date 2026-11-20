import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { timeAgo, useApi, useInterval, fmtDuration } from '../util.js';
import { useLookups } from '../components/Filters.jsx';
import {
  ErrorBox, Loading, Modal, StatusDot, useCanWrite, useToast,
} from '../components/ui.jsx';

const osLabel = (os) => ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[os] || os || '—');

export default function Machines() {
  const devices = useApi('/devices');
  const { employees } = useLookups();
  const canWrite = useCanWrite();
  const toast = useToast();
  const nav = useNavigate();
  const [selected, setSelected] = useState(new Set());
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('all');
  const [assignOpen, setAssignOpen] = useState(false);
  useInterval(() => devices.reload(), 20000);

  const list = useMemo(() => (devices.data || []).filter((d) => {
    const q = filter.toLowerCase();
    const matches = !q || [d.name, d.hostname, d.employeeName, d.osUser].some((v) => v?.toLowerCase().includes(q));
    const st = status === 'all' || (status === 'online' && d.online) || (status === 'offline' && !d.online)
      || (status === 'disabled' && d.status === 'disabled');
    return matches && st;
  }), [devices.data, filter, status]);

  const bulk = async (body, msg) => {
    try {
      await api('/devices/bulk', { method: 'POST', body: { ids: [...selected], ...body } });
      toast(msg);
      setSelected(new Set());
      devices.reload();
    } catch (e) { toast(e, 'error'); }
  };

  const toggleAll = () => setSelected(selected.size === list.length ? new Set() : new Set(list.map((d) => d.id)));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Machines</h1>
          <div className="sub">{devices.data?.length ?? 0} enrolled · {devices.data?.filter((d) => d.online).length ?? 0} online</div>
        </div>
        {canWrite && <button className="primary" onClick={() => nav('/machines/add')}>+ Add machine</button>}
      </div>
      <ErrorBox error={devices.error} />
      <div className="card flush">
        <div className="row" style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
          <input placeholder="Search name, user, employee…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ minWidth: 220 }} />
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All statuses</option><option value="online">Online</option>
            <option value="offline">Offline</option><option value="disabled">Disabled</option>
          </select>
          <div className="spacer" />
          {canWrite && selected.size > 0 && (
            <>
              <span className="muted small">{selected.size} selected</span>
              <button className="sm" onClick={() => setAssignOpen(true)}>Assign employee</button>
              <button className="sm" onClick={() => bulk({ action: 'command', command: 'screenshot' }, 'Screenshot requested')}>Take screenshot</button>
              <button className="sm" onClick={() => bulk({ action: 'enable' }, 'Monitoring enabled')}>Enable</button>
              <button className="sm danger" onClick={() => bulk({ action: 'disable' }, 'Monitoring disabled')}>Disable</button>
            </>
          )}
        </div>
        {devices.loading && !devices.data ? <Loading /> : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {canWrite && <th style={{ width: 36 }}><input type="checkbox" checked={list.length > 0 && selected.size === list.length} onChange={toggleAll} /></th>}
                  <th>Machine</th><th>Status</th><th>Employee</th><th>Now</th><th>OS</th><th>Agent</th><th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && (
                  <tr><td colSpan={8} className="empty">
                    {devices.data?.length ? 'No machines match the filter' : <>No machines yet. <Link to="/machines/add">Add your first machine</Link>.</>}
                  </td></tr>
                )}
                {list.map((d) => (
                  <tr key={d.id}>
                    {canWrite && (
                      <td><input type="checkbox" checked={selected.has(d.id)} onChange={() => {
                        const n = new Set(selected);
                        if (n.has(d.id)) n.delete(d.id); else n.add(d.id);
                        setSelected(n);
                      }} /></td>
                    )}
                    <td>
                      <Link to={`/machines/${d.id}`}><b>{d.name}</b></Link>
                      <div className="muted small">{d.osUser ? `${d.osUser}@` : ''}{d.hostname}</div>
                    </td>
                    <td>
                      <StatusDot device={d} />
                      {d.status === 'disabled' && <span className="badge bad" style={{ marginLeft: 6 }}>disabled</span>}
                      {Object.keys(d.policyOverride || {}).length > 0 && <span className="badge accent" style={{ marginLeft: 6 }}>custom policy</span>}
                    </td>
                    <td>{d.employeeName || <span className="muted">Unassigned</span>}</td>
                    <td className="wrap small" style={{ maxWidth: 240 }}>
                      {!d.online ? <span className="muted">—</span>
                        : d.idleSec > 180 ? <span className="muted">Idle {fmtDuration(d.idleSec)}</span>
                          : d.current ? <>{d.current.app}{d.current.domain && <span className="muted"> · {d.current.domain}</span>}</> : '—'}
                    </td>
                    <td>{osLabel(d.os)} <span className="muted small">{d.osVersion}</span></td>
                    <td className="small">{d.agentVersion || '—'}</td>
                    <td className="small">{d.online ? 'now' : timeAgo(d.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {assignOpen && <AssignModal employees={employees} onClose={() => setAssignOpen(false)}
        onSave={(employeeId) => bulk({ action: 'assign', employeeId }, 'Employee assigned').then(() => setAssignOpen(false))} />}
    </>
  );
}

function AssignModal({ employees, onClose, onSave }) {
  const [emp, setEmp] = useState('');
  return (
    <Modal title="Assign employee" onClose={onClose}
      actions={<><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => onSave(emp || null)}>Assign</button></>}>
      <label className="field">Employee
        <select value={emp} onChange={(e) => setEmp(e.target.value)}>
          <option value="">— Unassigned —</option>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
      </label>
    </Modal>
  );
}
