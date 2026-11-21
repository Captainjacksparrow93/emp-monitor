import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api, fileUrl } from '../api.js';
import { useOrg } from '../App.jsx';
import {
  deepMerge, diffObject, fmtDateTime, fmtDuration, shiftDate, timeAgo, today, useApi, useInterval,
} from '../util.js';
import { qs, useLookups } from '../components/Filters.jsx';
import PolicyEditor from '../components/PolicyEditor.jsx';
import {
  BarList, Confirm, ErrorBox, HourStrip, Loading, ProductivityMeter, StatusDot, useCanWrite, useToast,
} from '../components/ui.jsx';
import { Lightbox } from './Screenshots.jsx';

// Explains why screenshots are / aren't being captured, reported live by the agent.
function ScreenshotStatus({ shot }) {
  if (!shot || !shot.status || shot.status === 'none') return null;
  const map = {
    ok: ['good', `Capturing (${shot.count} screen${shot.count === 1 ? '' : 's'} last time)`],
    disabled: ['', 'Screenshots are turned off in the policy'],
    idle: ['', 'Paused while the user is idle (turn off “Skip while idle” to always capture)'],
    excluded: ['', 'Current app is excluded / private'],
    paused: ['warn', 'Monitoring is paused'],
    locked: ['', 'Screen is locked'],
    offhours: ['', 'Outside working hours'],
    'no-permission': ['bad', 'No Screen Recording permission — grant it in System Settings → Privacy & Security, then the agent restarts itself'],
    empty: ['bad', 'Screen Recording permission looks granted but macOS returns blank frames — the agent is relaunching to apply it. If it persists, open System Settings → Privacy & Security → Screen Recording, toggle EmpMonitor Agent off and on, and choose “Quit & Reopen”.'],
  };
  const [cls, text] = map[shot.status] || ['', `Screenshots: ${shot.status}`];
  return <div className={`note ${cls === 'bad' ? 'warn' : ''} mt small`}><b>Screenshots:</b> {text}</div>;
}

export default function MachineDetail() {
  const { id } = useParams();
  const dev = useApi(`/devices/${id}`);
  const [tab, setTab] = useState('activity');
  useInterval(() => dev.reload(), 20000);

  if (dev.error) return <ErrorBox error={dev.error} />;
  if (!dev.data) return <Loading />;
  const d = dev.data;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small"><Link to="/machines">← Machines</Link></div>
          <h1>{d.name}</h1>
          <div className="sub row">
            <StatusDot device={d} />
            <span>· {d.employeeName || 'Unassigned'}</span>
            <span>· {d.osUser ? `${d.osUser}@` : ''}{d.hostname}</span>
          </div>
        </div>
      </div>
      <div className="tabs">
        {[['activity', 'Activity'], ['screenshots', 'Screenshots'], ['policy', 'Policy'], ['manage', 'Manage']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'activity' && <ActivityTab device={d} />}
      {tab === 'screenshots' && <ShotsTab device={d} />}
      {tab === 'policy' && <PolicyTab device={d} onSaved={dev.reload} />}
      {tab === 'manage' && <ManageTab device={d} onSaved={dev.reload} />}
    </>
  );
}

function ActivityTab({ device: d }) {
  const org = useOrg();
  const [day, setDay] = useState(today(org.timezone));
  const timeline = useApi(`/analytics/timeline${qs({ from: day, deviceId: d.id })}`);
  const summary = useApi(`/analytics/summary${qs({ from: day, deviceId: d.id })}`);
  const s = summary.data;
  return (
    <div className="stack">
      <div className="grid cols-3">
        <div className="card">
          <h3>Right now</h3>
          {d.online ? (
            <>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{d.paused ? 'Paused by user' : d.idleSec > 180 ? `Idle for ${fmtDuration(d.idleSec)}` : d.current?.app || '—'}</div>
              {d.current?.domain && <div className="muted">{d.current.domain}</div>}
              {d.current?.title && <div className="muted small" style={{ marginTop: 4 }}>{d.current.title}</div>}
            </>
          ) : <div className="muted">Offline · last seen {timeAgo(d.lastSeen)}</div>}
          {d.permissions && Object.values(d.permissions).some((v) => v === false) && (
            <div className="note warn mt small">
              Missing macOS permission: {Object.entries(d.permissions).filter(([, v]) => v === false).map(([k]) => k).join(', ')}.
              Grant it in System Settings → Privacy &amp; Security on that Mac.
            </div>
          )}
          <ScreenshotStatus shot={d.lastShot} />
        </div>
        <div className="card">
          <h3>Machine</h3>
          <div className="small" style={{ lineHeight: 1.9 }}>
            <div>OS: {d.os} {d.osVersion}</div>
            <div>Agent: v{d.agentVersion || '?'}</div>
            <div>IP: {d.lastIp || '—'}</div>
            <div>Enrolled: {fmtDateTime(d.enrolledAt, org.timezone)}</div>
          </div>
        </div>
        <div className="card">
          <h3>{day === today(org.timezone) ? 'Today' : day}</h3>
          <div className="row" style={{ gap: 18 }}>
            <div><div className="muted small">Active</div><b style={{ fontSize: 18 }}>{s ? fmtDuration(s.totals.active) : '–'}</b></div>
            <div><div className="muted small">Idle</div><b style={{ fontSize: 18 }}>{s ? fmtDuration(s.totals.idle) : '–'}</b></div>
            <div><div className="muted small">Productivity</div><b style={{ fontSize: 18 }}>{s ? `${s.totals.productivity}%` : '–'}</b></div>
          </div>
          <div className="mt"><ProductivityMeter {...(s?.totals || {})} /></div>
        </div>
      </div>
      <div className="card">
        <div className="row between">
          <h2>Timeline</h2>
          <div className="row">
            <button className="sm" onClick={() => setDay(shiftDate(day, -1))}>‹</button>
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            <button className="sm" onClick={() => setDay(shiftDate(day, 1))} disabled={day >= today(org.timezone)}>›</button>
          </div>
        </div>
        {timeline.data ? <HourStrip hours={timeline.data} /> : <Loading />}
        <div className="legend"><span><i style={{ background: 'var(--accent)' }} />Active</span><span><i style={{ background: 'var(--idle)' }} />Idle</span></div>
      </div>
      <div className="grid cols-2">
        <div className="card"><h2>Applications</h2><BarList items={s?.topApps} /></div>
        <div className="card"><h2>Websites</h2><BarList items={s?.topDomains} /></div>
      </div>
    </div>
  );
}

function ShotsTab({ device }) {
  const org = useOrg();
  const [date, setDate] = useState(today(org.timezone));
  const shots = useApi(`/screenshots${qs({ deviceId: device.id, date, limit: 200 })}`);
  const [open, setOpen] = useState(null);
  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="sm" onClick={() => setDate(shiftDate(date, -1))}>‹</button>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="sm" onClick={() => setDate(shiftDate(date, 1))}>›</button>
        <span className="muted small">{shots.data?.length ?? 0} screenshots</span>
      </div>
      {shots.loading ? <Loading /> : shots.data?.length ? (
        <div className="shots">
          {shots.data.map((x, i) => (
            <div key={x.id} className="shot" onClick={() => setOpen(i)}>
              <img src={fileUrl(x.url)} alt="" loading="lazy" />
              <div className="meta"><b>{new Date(x.takenAt).toLocaleTimeString([], { timeZone: org.timezone })}</b><span className="muted">{x.app || '—'}{x.domain ? ` · ${x.domain}` : ''}</span></div>
            </div>
          ))}
        </div>
      ) : <div className="card empty">No screenshots on this day</div>}
      {open !== null && <Lightbox items={shots.data} index={open} onIndex={setOpen} onClose={() => setOpen(null)} onDeleted={shots.reload} />}
    </>
  );
}

function PolicyTab({ device, onSaved }) {
  const settings = useApi('/settings');
  const canWrite = useCanWrite();
  const toast = useToast();
  const [draft, setDraft] = useState(null);
  useEffect(() => {
    if (settings.data) setDraft(deepMerge(settings.data.policy, device.policyOverride || {}));
  }, [settings.data, device.policyOverride]);
  if (!draft) return <Loading />;
  const override = diffObject(settings.data.policy, draft);
  const save = async (body) => {
    try {
      await api(`/devices/${device.id}`, { method: 'PATCH', body: { policyOverride: body } });
      toast('Policy saved — the agent picks it up on its next heartbeat');
      onSaved();
    } catch (e) { toast(e, 'error'); }
  };
  return (
    <div className="stack">
      <div className="note">
        This machine follows the <Link to="/policy">global policy</Link>. Any setting you change here becomes a per-machine override
        ({Object.keys(override).length ? <b>{JSON.stringify(override)}</b> : 'currently none'}).
      </div>
      <PolicyEditor value={draft} onChange={setDraft} disabled={!canWrite} />
      {canWrite && (
        <div className="row">
          <button className="primary" onClick={() => save(override)}>Save override</button>
          <button onClick={() => { setDraft(settings.data.policy); save({}); }}>Reset to global policy</button>
        </div>
      )}
    </div>
  );
}

function ManageTab({ device: d, onSaved }) {
  const canWrite = useCanWrite();
  const toast = useToast();
  const nav = useNavigate();
  const { employees } = useLookups();
  const [name, setName] = useState(d.name);
  const [confirm, setConfirm] = useState(null);
  const [message, setMessage] = useState('');

  const patch = async (body, msg) => {
    try { await api(`/devices/${d.id}`, { method: 'PATCH', body }); toast(msg); onSaved(); } catch (e) { toast(e, 'error'); }
  };
  const cmd = async (type, args) => {
    try {
      await api(`/devices/${d.id}/commands`, { method: 'POST', body: { type, args } });
      toast('Command queued — delivered on the next heartbeat');
      onSaved();
    } catch (e) { toast(e, 'error'); }
  };

  if (!canWrite) return <div className="card muted">Your account is read-only.</div>;
  return (
    <div className="stack">
      <div className="card">
        <h2>Details</h2>
        <div className="form-grid">
          <label className="field">Display name
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
              <button onClick={() => patch({ name }, 'Renamed')} disabled={name === d.name}>Save</button>
            </div>
          </label>
          <label className="field">Assigned employee
            <select value={d.employeeId || ''} onChange={(e) => patch({ employeeId: e.target.value || null }, 'Employee updated')}>
              <option value="">— Unassigned —</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
            <span className="help">New activity is attributed to this employee.</span>
          </label>
        </div>
      </div>
      <div className="card">
        <h2>Remote actions</h2>
        <p className="muted small" style={{ marginTop: -6 }}>Delivered on the agent's next heartbeat ({d.pendingCommands} pending).</p>
        <div className="row">
          <button onClick={() => cmd('screenshot')}>Take screenshot now</button>
          <button onClick={() => cmd('pause', { minutes: 30 })}>Pause 30 min</button>
          <button onClick={() => cmd('resume')}>Resume</button>
          <button onClick={() => cmd('refresh-config')}>Reload policy</button>
          <button onClick={() => cmd('restart')}>Restart agent</button>
        </div>
        <div className="row mt">
          <input placeholder="Show a message on this computer…" value={message} onChange={(e) => setMessage(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
          <button disabled={!message} onClick={() => { cmd('show-message', { text: message }); setMessage(''); }}>Send message</button>
        </div>
      </div>
      <div className="card">
        <h2>Danger zone</h2>
        <div className="row">
          {d.status === 'active'
            ? <button onClick={() => patch({ status: 'disabled' }, 'Monitoring disabled')}>Disable monitoring</button>
            : <button onClick={() => patch({ status: 'active' }, 'Monitoring enabled')}>Enable monitoring</button>}
          <button className="danger" onClick={() => setConfirm('revoke')}>Revoke &amp; uninstall</button>
          <button className="danger" onClick={() => setConfirm('purge')}>Delete machine and all data</button>
        </div>
      </div>
      {confirm === 'revoke' && (
        <Confirm title="Revoke this machine?" danger confirmLabel="Revoke"
          message="The agent's access is revoked and it removes itself from login items. History is kept. The machine can be re-enrolled later with a new code."
          onClose={() => setConfirm(null)}
          onConfirm={async () => { await api(`/devices/${d.id}`, { method: 'DELETE' }); toast('Machine revoked'); onSaved(); }} />
      )}
      {confirm === 'purge' && (
        <Confirm title="Delete machine and all its data?" danger confirmLabel="Delete everything"
          message="This permanently deletes the machine, its activity history and its screenshots. This cannot be undone."
          onClose={() => setConfirm(null)}
          onConfirm={async () => { await api(`/devices/${d.id}?purge=1`, { method: 'DELETE' }); toast('Machine deleted'); nav('/machines'); }} />
      )}
    </div>
  );
}
