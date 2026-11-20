import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { fmtDateTime, useApi } from '../util.js';
import { useLookups } from '../components/Filters.jsx';
import { ErrorBox, Loading, useToast } from '../components/ui.jsx';

export default function AddMachine() {
  const tokens = useApi('/enroll-tokens');
  const { employees } = useLookups();
  const toast = useToast();
  const [form, setForm] = useState({ label: '', employeeId: '', usesLeft: '1', expiresInDays: '7' });
  const [created, setCreated] = useState(null);
  const [os, setOs] = useState('win');

  const create = async (e) => {
    e.preventDefault();
    try {
      const t = await api('/enroll-tokens', {
        method: 'POST',
        body: { ...form, usesLeft: form.usesLeft === 'unlimited' ? null : form.usesLeft, expiresInDays: form.expiresInDays || null },
      });
      setCreated(t);
      tokens.reload();
    } catch (err) { toast(err, 'error'); }
  };

  const del = async (id) => {
    await api(`/enroll-tokens/${id}`, { method: 'DELETE' });
    tokens.reload();
  };

  const server = tokens.data?.serverUrl || '';
  const code = created?.code || 'XXXXX-XXXXX';
  const dl = tokens.data?.downloads || {};

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small"><Link to="/machines">← Machines</Link></div>
          <h1>Add machines</h1>
          <div className="sub">Install the agent on Windows or macOS and enroll it with a code.</div>
        </div>
      </div>
      <ErrorBox error={tokens.error} />
      <div className="grid cols-2">
        <form className="card stack" onSubmit={create}>
          <h2 style={{ margin: 0 }}>1. Create an enrollment code</h2>
          <label className="field">Label
            <input value={form.label} placeholder="e.g. Sales laptops" onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </label>
          <label className="field">Assign to employee
            <select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}>
              <option value="">— Assign later —</option>
              {employees.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <div className="form-grid">
            <label className="field">Can be used
              <select value={form.usesLeft} onChange={(e) => setForm({ ...form, usesLeft: e.target.value })}>
                <option value="1">Once (one machine)</option>
                <option value="10">10 machines</option>
                <option value="50">50 machines</option>
                <option value="unlimited">Unlimited (mass deployment)</option>
              </select>
            </label>
            <label className="field">Expires
              <select value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })}>
                <option value="1">In 1 day</option><option value="7">In 7 days</option>
                <option value="30">In 30 days</option><option value="">Never</option>
              </select>
            </label>
          </div>
          <button className="primary">Generate code</button>
          {created && (
            <div className="note" style={{ textAlign: 'center' }}>
              <div className="muted small">Enrollment code</div>
              <div className="big-code">{created.code}</div>
              <button type="button" className="sm mt" onClick={() => navigator.clipboard?.writeText(created.code).then(() => toast('Copied'))}>Copy</button>
            </div>
          )}
        </form>

        <div className="card stack">
          <h2 style={{ margin: 0 }}>2. Install the agent</h2>
          <div className="tabs" style={{ marginBottom: 0 }}>
            <button type="button" className={os === 'win' ? 'active' : ''} onClick={() => setOs('win')}>Windows</button>
            <button type="button" className={os === 'mac' ? 'active' : ''} onClick={() => setOs('mac')}>macOS</button>
            <button type="button" className={os === 'mass' ? 'active' : ''} onClick={() => setOs('mass')}>Mass deployment</button>
          </div>
          {os === 'win' && (
            <ol className="small" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.8 }}>
              <li>Download <b>EmpMonitor-Agent-Setup.exe</b>{dl.win && <> from <a href={dl.win} target="_blank" rel="noreferrer">here</a></>}.</li>
              <li>Run the installer, then enter the server URL <code>{server}</code> and the code <code>{code}</code>.</li>
              <li>The agent starts automatically at login and shows a tray icon.</li>
            </ol>
          )}
          {os === 'mac' && (
            <ol className="small" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.8 }}>
              <li>Download <b>EmpMonitor-Agent.dmg</b>{dl.mac && <> from <a href={dl.mac} target="_blank" rel="noreferrer">here</a></>} and drag it to Applications.</li>
              <li>Open it, then enter the server URL <code>{server}</code> and the code <code>{code}</code>.</li>
              <li>macOS asks for <b>Screen Recording</b> (screenshots) and <b>Accessibility</b> (window titles and URLs). Allow both in System Settings → Privacy &amp; Security, then restart the agent from its menu bar icon.</li>
            </ol>
          )}
          {os === 'mass' && (
            <div className="small stack" style={{ gap: 10 }}>
              <div>Create an <b>unlimited</b> code, then pre-configure machines silently (Intune, GPO, Jamf, MDM) by placing an <code>enroll.json</code> file before first launch:</div>
              <div className="codebox mono">{JSON.stringify({ serverUrl: server, code }, null, 2)}</div>
              <div>Windows: <code>C:\ProgramData\EmpMonitorAgent\enroll.json</code><br />macOS: <code>/Library/Application Support/EmpMonitorAgent/enroll.json</code></div>
              <div>Silent Windows install:</div>
              <div className="codebox mono">EmpMonitor-Agent-Setup.exe /S</div>
              <div>Or pass the values on the command line: <code>--server={server} --code={code}</code></div>
            </div>
          )}
        </div>
      </div>

      <div className="card flush mt">
        <div style={{ padding: '16px 18px 4px' }}><h2>Enrollment codes</h2></div>
        {!tokens.data ? <Loading /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Code</th><th>Label</th><th>Employee</th><th>Uses left</th><th>Expires</th><th /></tr></thead>
              <tbody>
                {tokens.data.tokens.length === 0 && <tr><td colSpan={6} className="empty">No codes yet</td></tr>}
                {tokens.data.tokens.map((t) => {
                  const expired = (t.expires_at && new Date(t.expires_at) < new Date()) || t.uses_left === 0;
                  return (
                    <tr key={t.id}>
                      <td className="mono"><b>{t.code}</b> {expired && <span className="badge bad">expired</span>}</td>
                      <td>{t.label || '—'}</td>
                      <td>{t.employee_name || '—'}</td>
                      <td>{t.uses_left ?? '∞'}</td>
                      <td>{t.expires_at ? fmtDateTime(t.expires_at) : 'Never'}</td>
                      <td className="num"><button className="sm danger" onClick={() => del(t.id)}>Delete</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
