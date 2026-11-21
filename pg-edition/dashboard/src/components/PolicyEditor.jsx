// Monitoring policy form, used for the global policy and for per-machine overrides.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Check({ label, help, checked, onChange, disabled }) {
  return (
    <label className="check">
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}{help && <span className="help">{help}</span>}</span>
    </label>
  );
}

function Num({ label, help, value, onChange, min, max, step = 1, disabled, suffix }) {
  return (
    <label className="field">
      {label}
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input type="number" value={value} min={min} max={max} step={step} disabled={disabled}
          style={{ width: '100%' }} onChange={(e) => onChange(Number(e.target.value))} />
        {suffix && <span className="muted small">{suffix}</span>}
      </div>
      {help && <span className="help">{help}</span>}
    </label>
  );
}

export default function PolicyEditor({ value, onChange, disabled }) {
  const p = value;
  const set = (path, v) => {
    const next = structuredClone(p);
    const keys = path.split('.');
    let o = next;
    keys.slice(0, -1).forEach((k) => { o = o[k]; });
    o[keys.at(-1)] = v;
    onChange(next);
  };
  const shotsPerDay = p.screenshots.enabled ? Math.round((9 * 60) / p.screenshots.intervalMin) : 0;
  const approxKb = Math.round((p.screenshots.maxWidth / 1600) ** 2 * (p.screenshots.quality / 55) * 180);

  return (
    <div className="stack">
      <div className="card">
        <h2>General</h2>
        <div className="form-grid">
          <Check label="Monitoring enabled" help="Master switch. When off, agents stay connected but collect nothing."
            checked={p.enabled} disabled={disabled} onChange={(v) => set('enabled', v)} />
          <Check label="Stealth mode" help="Hide the agent completely: no tray / menu-bar icon, no notice, no windows. Check your local laws — most require you to disclose monitoring to employees even when the software is hidden."
            checked={p.stealth} disabled={disabled} onChange={(v) => set('stealth', v)} />
          <Check label="Auto-restart (tamper resistance)" help="Relaunch the agent if it is ended from Task Manager / Activity Monitor (Windows: within ~1 min, macOS: within seconds). An administrator can still uninstall it."
            checked={p.autoRestart} disabled={disabled} onChange={(v) => set('autoRestart', v)} />
          <Check label="Show monitoring notice" help="Employees see a one-time notice and a tray icon so they know this computer is monitored. Ignored in stealth mode."
            checked={p.showNotice && !p.stealth} disabled={disabled || p.stealth} onChange={(v) => set('showNotice', v)} />
          <Check label="Employees can pause" help="Lets the user pause tracking from the tray menu (e.g. for personal time). Ignored in stealth mode (no tray)."
            checked={p.allowPause && !p.stealth} disabled={disabled || p.stealth} onChange={(v) => set('allowPause', v)} />
          <Num label="Max pause length" value={p.maxPauseMin} min={1} max={480} suffix="min"
            disabled={disabled || !p.allowPause || p.stealth} onChange={(v) => set('maxPauseMin', v)} />
        </div>
      </div>

      <div className="card">
        <h2>Screenshots</h2>
        <div className="form-grid">
          <Check label="Capture screenshots" checked={p.screenshots.enabled} disabled={disabled}
            onChange={(v) => set('screenshots.enabled', v)} />
          <Num label="Interval" value={p.screenshots.intervalMin} min={1} max={240} suffix="min" disabled={disabled}
            help={`≈ ${shotsPerDay} per 9-hour day, ~${approxKb} KB each`} onChange={(v) => set('screenshots.intervalMin', v)} />
          <label className="field">
            JPEG quality: {p.screenshots.quality}
            <input type="range" min={10} max={95} value={p.screenshots.quality} disabled={disabled}
              onChange={(e) => set('screenshots.quality', Number(e.target.value))} />
            <span className="help">Lower = smaller files. 50–60 is plenty for reviewing work.</span>
          </label>
          <Num label="Max width" value={p.screenshots.maxWidth} min={640} max={3840} step={10} suffix="px" disabled={disabled}
            help="Large screens are scaled down to this width." onChange={(v) => set('screenshots.maxWidth', v)} />
          <Check label="Random timing" help="Screenshots are taken at a random moment inside each interval." checked={p.screenshots.jitter}
            disabled={disabled} onChange={(v) => set('screenshots.jitter', v)} />
          <Check label="All monitors" help="Capture every display side-by-side instead of the primary only." checked={p.screenshots.allScreens}
            disabled={disabled} onChange={(v) => set('screenshots.allScreens', v)} />
          <Check label="Blur screenshots" help="Privacy mode: shows what kind of work is happening without readable text." checked={p.screenshots.blur}
            disabled={disabled} onChange={(v) => set('screenshots.blur', v)} />
          <Check label="Skip while idle" help="Don't capture when the user is away from the keyboard." checked={p.screenshots.skipWhenIdle}
            disabled={disabled} onChange={(v) => set('screenshots.skipWhenIdle', v)} />
        </div>
      </div>

      <div className="card">
        <h2>Activity tracking</h2>
        <div className="form-grid">
          <Check label="Track applications" checked={p.activity.trackApps} disabled={disabled} onChange={(v) => set('activity.trackApps', v)} />
          <Check label="Track websites" help="Domain only (e.g. github.com), never full URLs." checked={p.activity.trackWeb}
            disabled={disabled} onChange={(v) => set('activity.trackWeb', v)} />
          <Check label="Window titles in live view" help="Shown live on the dashboard only; never stored in the database." checked={p.activity.trackTitles}
            disabled={disabled} onChange={(v) => set('activity.trackTitles', v)} />
          <Num label="Idle after" value={p.activity.idleThresholdSec} min={30} max={3600} suffix="sec" disabled={disabled}
            help="No keyboard/mouse input for this long counts as idle." onChange={(v) => set('activity.idleThresholdSec', v)} />
          <Num label="Sample every" value={p.activity.sampleSec} min={2} max={60} suffix="sec" disabled={disabled}
            onChange={(v) => set('activity.sampleSec', v)} />
          <label className="field">
            Excluded apps
            <textarea rows={3} disabled={disabled} value={(p.excludedApps || []).join('\n')}
              placeholder={'1Password\nKeePassXC'}
              onChange={(e) => set('excludedApps', e.target.value.split('\n'))} />
            <span className="help">One per line. Never tracked or screenshotted.</span>
          </label>
        </div>
      </div>

      <div className="card">
        <h2>Working hours</h2>
        <div className="form-grid">
          <Check label="Only monitor during working hours" help="Uses each computer's local time."
            checked={p.schedule.enabled} disabled={disabled} onChange={(v) => set('schedule.enabled', v)} />
          <label className="field">
            Start
            <input type="time" value={p.schedule.start} disabled={disabled || !p.schedule.enabled} onChange={(e) => set('schedule.start', e.target.value)} />
          </label>
          <label className="field">
            End
            <input type="time" value={p.schedule.end} disabled={disabled || !p.schedule.enabled} onChange={(e) => set('schedule.end', e.target.value)} />
          </label>
          <div className="field">
            Days
            <div className="row" style={{ gap: 4 }}>
              {DAYS.map((d, i) => {
                const on = p.schedule.days.includes(i);
                return (
                  <button key={d} type="button" className={`sm ${on ? 'primary' : ''}`} disabled={disabled || !p.schedule.enabled}
                    onClick={() => set('schedule.days', on ? p.schedule.days.filter((x) => x !== i) : [...p.schedule.days, i].sort())}>
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Network &amp; database usage</h2>
        <div className="form-grid">
          <Num label="Upload every" value={p.uploadIntervalMin} min={1} max={120} suffix="min" disabled={disabled}
            help="Agents batch data locally and upload it in one request." onChange={(v) => set('uploadIntervalMin', v)} />
          <Num label="Heartbeat every" value={p.heartbeatSec} min={30} max={900} suffix="sec" disabled={disabled}
            help="Online status + live view. Heartbeats never touch the database." onChange={(v) => set('heartbeatSec', v)} />
        </div>
      </div>
    </div>
  );
}
