import { useState } from 'react';
import { api } from '../api.js';
import { fmtBytes, fmtDateTime, timeAgo, useApi } from '../util.js';
import { ErrorBox, Loading, useCanWrite, useToast } from '../components/ui.jsx';

function Gauge({ used, limit, label }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const cls = pct > 85 ? 'bad' : pct > 65 ? 'warn' : 'accent';
  return (
    <>
      <div className="row between"><b style={{ fontSize: 22 }}>{label}</b><span className="muted">{pct.toFixed(1)}%</span></div>
      <div className="meter mt" style={{ height: 14 }}><span className={cls} style={{ width: `${Math.max(pct, 0.5)}%` }} /></div>
    </>
  );
}

const TABLE_INFO = {
  activity_app: 'Per-hour app & website time',
  activity_device: 'Per-hour active / idle time',
  screenshots: 'Screenshot metadata (images are stored outside the DB)',
  audit_log: 'Admin action history',
  devices: 'Enrolled machines',
  employees: 'Employees',
  productivity_rules: 'Productivity rules',
  enroll_tokens: 'Enrollment codes',
  settings: 'Settings',
  admins: 'Dashboard accounts',
  departments: 'Departments',
};

export default function System() {
  const sys = useApi('/system');
  const canWrite = useCanWrite();
  const toast = useToast();
  const [busy, setBusy] = useState('');

  const action = async (path, msg) => {
    setBusy(path);
    try {
      const r = await api(path, { method: 'POST' });
      toast(typeof msg === 'function' ? msg(r) : msg);
      sys.reload();
    } catch (e) { toast(e, 'error'); } finally { setBusy(''); }
  };

  if (sys.error) return <ErrorBox error={sys.error} />;
  if (!sys.data) return <Loading />;
  const { db, neon, compute, buffer, storage, maintenance, retention } = sys.data;
  const ep = neon.endpoints?.find((e) => e.type === 'read_write') || neon.endpoints?.[0];

  return (
    <>
      <div className="page-head">
        <div><h1>Database &amp; system</h1><div className="sub">Neon free-tier usage, buffering and maintenance</div></div>
        <button onClick={sys.reload}>Refresh</button>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Database storage</h3>
          <Gauge used={db.sizeBytes} limit={db.limitBytes} label={`${fmtBytes(db.sizeBytes)} of ${fmtBytes(db.limitBytes)}`} />
          <div className="muted small mt">
            Database <code>{db.name}</code> · PostgreSQL {db.serverVersion}
          </div>
          <div className="muted small">
            Oldest activity: {db.oldest_activity || '—'} · {db.screenshots} screenshots (metadata only, {fmtBytes(db.screenshots * 120)} in DB)
          </div>
          {db.sizeBytes / db.limitBytes > 0.8 && (
            <div className="note warn mt small">Storage is above 80%. Shorten activity retention in Settings, then run cleanup and vacuum below.</div>
          )}
        </div>

        <div className="card">
          <h3>Neon compute (CU-hours)</h3>
          {neon.configured && neon.cuHoursUsed != null ? (
            <>
              <Gauge used={neon.cuHoursUsed} limit={neon.cuHoursLimit}
                label={`${neon.cuHoursUsed.toFixed(1)} of ${neon.cuHoursLimit} CU-h`} />
              <div className="muted small mt">
                Billing period {neon.periodStart ? new Date(neon.periodStart).toLocaleDateString() : '?'} – {neon.periodEnd ? new Date(neon.periodEnd).toLocaleDateString() : '?'}
                {neon.activeTimeSeconds != null && <> · awake {(neon.activeTimeSeconds / 3600).toFixed(1)} h</>}
              </div>
            </>
          ) : neon.error ? <div className="error-box small">Neon API: {neon.error}</div> : (
            <div className="muted small">
              Set <code>NEON_API_KEY</code> and <code>NEON_PROJECT_ID</code> on the server to show the exact CU-hours used this month.
            </div>
          )}
          {ep && (
            <div className="small mt" style={{ lineHeight: 1.8 }}>
              Compute <span className={`badge ${ep.state === 'active' ? 'good' : ''}`}>{ep.state}</span> · autoscale {ep.minCu}–{ep.maxCu} CU
              · suspend after {ep.suspendTimeoutSeconds > 0 ? `${ep.suspendTimeoutSeconds}s` : 'default (5 min)'}
              · last active {timeAgo(ep.lastActive)}
              {ep.maxCu > 0.5 && <div className="note warn small mt">Max autoscale is {ep.maxCu} CU. For this workload 0.25–0.5 CU is enough; a lower maximum keeps CU-hours down.</div>}
              {ep.suspendTimeoutSeconds < 0 && <div className="note warn small mt">Auto-suspend is disabled, so the compute never sleeps and burns CU-hours 24/7.</div>}
            </div>
          )}
        </div>
      </div>

      <div className="grid cols-3 mt">
        <div className="card">
          <h3>Compute wake-ups (this server)</h3>
          <div style={{ fontSize: 22, fontWeight: 650 }}>{compute.wakeups} <span className="muted small">in {compute.uptimeHours.toFixed(1)} h</span></div>
          <div className="small muted">
            Estimated awake {compute.estAwakeHours.toFixed(1)} h ({Math.round(compute.dutyCycle * 100)}% of uptime)
            ≈ {(compute.estAwakeHours * 0.25).toFixed(1)} CU-h at 0.25 CU.
          </div>
          <div className="small mt">
            DB is {compute.awakeNow ? <span className="badge good">probably awake</span> : <span className="badge">probably suspended</span>}
            {' '}· {compute.queries} queries · last {timeAgo(compute.lastQueryAt)}
          </div>
        </div>
        <div className="card">
          <h3>Write buffer</h3>
          <div style={{ fontSize: 22, fontWeight: 650 }}>{buffer.pendingRows} <span className="muted small">rows waiting</span></div>
          <div className="small muted">
            Flushed every {buffer.flushIntervalMin} min, or when the dashboard loads data. Spool on disk: {fmtBytes(buffer.spoolBytes)}.
          </div>
          <div className="small mt">
            Last flush: {buffer.lastFlushAt ? `${timeAgo(buffer.lastFlushAt)} (${buffer.lastFlushRows} rows, ${buffer.lastFlushMs} ms)` : 'not yet'}
            <br />Next: {buffer.nextFlushAt ? fmtDateTime(buffer.nextFlushAt) : '—'} · {buffer.skippedEmpty} empty flushes skipped (no wake-up)
          </div>
          {buffer.lastError && <div className="error-box small mt">{buffer.lastError}</div>}
          {canWrite && <button className="sm mt" disabled={busy === '/system/flush'} onClick={() => action('/system/flush', (r) => `Flushed ${r.rows} rows`)}>Flush now</button>}
        </div>
        <div className="card">
          <h3>Screenshot storage</h3>
          <div style={{ fontSize: 22, fontWeight: 650 }}>{fmtBytes(storage.localBytes ?? db.screenshotBytes)}</div>
          <div className="small muted">
            {storage.driver === 's3' ? <>S3-compatible bucket <code>{storage.bucket}</code></> : <>Local disk on the API server</>}
            {' '}· kept {retention.screenshotsDays} days
          </div>
          {storage.driver === 'local' && (
            <div className="note small mt">Tip: use Cloudflare R2 (10 GB free) via the <code>S3_*</code> settings if your host's disk isn't persistent.</div>
          )}
        </div>
      </div>

      <div className="card flush mt">
        <div style={{ padding: '16px 18px 4px' }}><h2>Tables</h2></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Table</th><th>Contents</th><th className="num">Rows (est.)</th><th className="num">Data</th><th className="num">Total incl. indexes</th><th style={{ width: 160 }}>Share</th></tr></thead>
            <tbody>
              {db.tables.map((t) => (
                <tr key={t.name}>
                  <td className="mono">{t.name}</td>
                  <td className="muted small">{TABLE_INFO[t.name] || ''}</td>
                  <td className="num">{Number(t.est_rows).toLocaleString()}</td>
                  <td className="num">{fmtBytes(t.table_bytes)}</td>
                  <td className="num">{fmtBytes(t.total_bytes)}</td>
                  <td><div className="meter"><span className="accent" style={{ width: `${(t.total_bytes / db.sizeBytes) * 100}%` }} /></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card mt">
        <h2>Maintenance</h2>
        <p className="small muted" style={{ marginTop: -6 }}>
          Retention cleanup runs automatically once a day, right after a scheduled flush, so it never wakes the database on its own.
          Activity is kept {retention.activityDays} days, screenshots {retention.screenshotsDays} days (change in Settings).
          Last run: {maintenance.lastCleanupAt ? `${timeAgo(maintenance.lastCleanupAt)} — removed ${maintenance.lastResult?.screenshots ?? 0} screenshots, ${maintenance.lastResult?.activityRows ?? 0} activity rows` : 'never'}.
        </p>
        {canWrite && (
          <div className="row">
            <button disabled={!!busy} onClick={() => action('/system/cleanup', 'Cleanup finished')}>Run retention cleanup now</button>
            <button disabled={!!busy} onClick={() => action('/system/vacuum', 'Vacuum finished')}>Vacuum tables</button>
          </div>
        )}
      </div>
    </>
  );
}
