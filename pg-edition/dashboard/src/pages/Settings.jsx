import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useOrg } from '../App.jsx';
import { fmtDateTime, useApi } from '../util.js';
import {
  Confirm, Loading, Modal, useAuth, useCanWrite, useToast,
} from '../components/ui.jsx';

const ZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['UTC'];

export default function Settings() {
  const [tab, setTab] = useState('org');
  return (
    <>
      <div className="page-head"><div><h1>Settings</h1></div></div>
      <div className="tabs">
        {[['org', 'Organization'], ['retention', 'Data retention'], ['admins', 'Dashboard users'], ['account', 'My account'], ['audit', 'Audit log']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'org' && <OrgTab />}
      {tab === 'retention' && <RetentionTab />}
      {tab === 'admins' && <AdminsTab />}
      {tab === 'account' && <AccountTab />}
      {tab === 'audit' && <AuditTab />}
    </>
  );
}

function OrgTab() {
  const org = useOrg();
  const canWrite = useCanWrite();
  const toast = useToast();
  const [form, setForm] = useState({ name: org.name, timezone: org.timezone });
  useEffect(() => setForm({ name: org.name, timezone: org.timezone }), [org.name, org.timezone]);
  const save = async (e) => {
    e.preventDefault();
    try {
      const o = await api('/settings/org', { method: 'PUT', body: form });
      org.setOrg(o);
      toast('Saved');
    } catch (err) { toast(err, 'error'); }
  };
  return (
    <form className="card stack" style={{ maxWidth: 560 }} onSubmit={save}>
      <label className="field">Company name<input value={form.name} disabled={!canWrite} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label className="field">Reporting timezone
        <select value={form.timezone} disabled={!canWrite} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
          {ZONES.map((z) => <option key={z}>{z}</option>)}
        </select>
        <span className="help">Decides which calendar day activity belongs to. Set it before you start collecting data: changing it later only affects new data.</span>
      </label>
      {canWrite && <div><button className="primary">Save</button></div>}
    </form>
  );
}

function RetentionTab() {
  const settings = useApi('/settings');
  const canWrite = useCanWrite();
  const toast = useToast();
  const [r, setR] = useState(null);
  useEffect(() => { if (settings.data) setR(settings.data.retention); }, [settings.data]);
  if (!r) return <Loading />;
  const save = async (e) => {
    e.preventDefault();
    try { setR(await api('/settings/retention', { method: 'PUT', body: r })); toast('Saved'); } catch (err) { toast(err, 'error'); }
  };
  return (
    <form className="card stack" style={{ maxWidth: 560 }} onSubmit={save}>
      <div className="note small">
        Neon's free plan includes 0.5 GB. Activity is stored pre-aggregated per hour (roughly 10–30 KB per machine per day),
        so 180 days fits about 50–100 machines. Screenshot <b>images</b> don't count against the database; only ~120 bytes of metadata each.
      </div>
      <label className="field">Keep activity for (days)<input type="number" min={1} value={r.activityDays} disabled={!canWrite} onChange={(e) => setR({ ...r, activityDays: Number(e.target.value) })} /></label>
      <label className="field">Keep screenshots for (days)<input type="number" min={1} value={r.screenshotsDays} disabled={!canWrite} onChange={(e) => setR({ ...r, screenshotsDays: Number(e.target.value) })} /></label>
      <label className="field">Keep audit log for (days)<input type="number" min={1} value={r.auditDays} disabled={!canWrite} onChange={(e) => setR({ ...r, auditDays: Number(e.target.value) })} /></label>
      {canWrite && <div><button className="primary">Save</button></div>}
    </form>
  );
}

function AdminsTab() {
  const admins = useApi('/auth/admins');
  const canWrite = useCanWrite();
  const { admin: me } = useAuth();
  const toast = useToast();
  const [add, setAdd] = useState(null);
  const [del, setDel] = useState(null);
  const create = async (e) => {
    e.preventDefault();
    try { await api('/auth/admins', { method: 'POST', body: add }); setAdd(null); admins.reload(); toast('User created'); } catch (err) { toast(err, 'error'); }
  };
  return (
    <div className="card flush">
      <div className="row between" style={{ padding: 14 }}>
        <span className="muted small">Administrators can change everything. Viewers can only look.</span>
        {canWrite && <button className="primary sm" onClick={() => setAdd({ email: '', name: '', password: '', role: 'viewer' })}>+ Add user</button>}
      </div>
      {!admins.data ? <Loading /> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Created</th><th /></tr></thead>
            <tbody>
              {admins.data.map((a) => (
                <tr key={a.id}>
                  <td>{a.name || '—'} {a.id === me.id && <span className="badge accent">you</span>}</td>
                  <td>{a.email}</td>
                  <td>
                    {canWrite && a.id !== me.id ? (
                      <select value={a.role} onChange={async (e) => { await api(`/auth/admins/${a.id}`, { method: 'PATCH', body: { role: e.target.value } }); admins.reload(); }}>
                        <option value="admin">Administrator</option><option value="viewer">Viewer</option>
                      </select>
                    ) : (a.role === 'admin' ? 'Administrator' : 'Viewer')}
                  </td>
                  <td>{fmtDateTime(a.created_at)}</td>
                  <td className="num">{canWrite && a.id !== me.id && <button className="sm ghost danger" onClick={() => setDel(a)}>Delete</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {add && (
        <Modal title="Add dashboard user" onClose={() => setAdd(null)}>
          <form className="stack" onSubmit={create}>
            <label className="field">Name<input value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} /></label>
            <label className="field">Email<input type="email" required value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} /></label>
            <label className="field">Temporary password<input type="password" required minLength={8} value={add.password} onChange={(e) => setAdd({ ...add, password: e.target.value })} /></label>
            <label className="field">Role
              <select value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value })}>
                <option value="viewer">Viewer (read-only)</option><option value="admin">Administrator</option>
              </select>
            </label>
            <div className="actions" style={{ marginTop: 0 }}><button type="button" onClick={() => setAdd(null)}>Cancel</button><button className="primary">Create</button></div>
          </form>
        </Modal>
      )}
      {del && <Confirm title={`Delete ${del.email}?`} danger confirmLabel="Delete" message="They will no longer be able to sign in."
        onClose={() => setDel(null)} onConfirm={async () => { await api(`/auth/admins/${del.id}`, { method: 'DELETE' }); admins.reload(); }} />}
    </div>
  );
}

function AccountTab() {
  const { admin } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ name: admin.name || '', password: '', confirm: '' });
  const save = async (e) => {
    e.preventDefault();
    if (form.password && form.password !== form.confirm) return toast('Passwords do not match', 'error');
    try {
      await api(`/auth/admins/${admin.id}`, { method: 'PATCH', body: { name: form.name, password: form.password || undefined } });
      setForm({ ...form, password: '', confirm: '' });
      return toast('Saved');
    } catch (err) { return toast(err, 'error'); }
  };
  return (
    <form className="card stack" style={{ maxWidth: 480 }} onSubmit={save}>
      <label className="field">Email<input value={admin.email} disabled /></label>
      <label className="field">Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label className="field">New password<input type="password" minLength={8} value={form.password} autoComplete="new-password" onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
      <label className="field">Confirm new password<input type="password" value={form.confirm} autoComplete="new-password" onChange={(e) => setForm({ ...form, confirm: e.target.value })} /></label>
      <div><button className="primary">Save</button></div>
    </form>
  );
}

function AuditTab() {
  const log = useApi('/settings/audit');
  if (!log.data) return <Loading />;
  return (
    <div className="card flush">
      <div className="table-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            {log.data.length === 0 && <tr><td colSpan={4} className="empty">Nothing yet</td></tr>}
            {log.data.map((l) => (
              <tr key={l.id}>
                <td>{fmtDateTime(l.at)}</td><td>{l.admin_email || 'system'}</td><td className="mono">{l.action}</td>
                <td className="wrap small muted mono">{JSON.stringify(l.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
