// In-memory state. Everything an *agent* request needs is answered from here so that
// heartbeats / config polls from every machine never touch Postgres (and never wake Neon).
// Single-instance design: run ONE server process.
import crypto from 'node:crypto';
import { query } from './db.js';

export const DEFAULT_POLICY = {
  enabled: true,
  screenshots: {
    enabled: true,
    intervalMin: 10,      // average minutes between screenshots
    jitter: true,         // randomise timing so it is not predictable
    quality: 55,          // JPEG quality 1-100
    maxWidth: 1600,       // downscale wide screens (saves storage + bandwidth)
    blur: false,          // privacy blur
    allScreens: true,     // capture every monitor (stitched side by side)
    skipWhenIdle: true,   // no screenshots while the user is idle
  },
  activity: {
    trackApps: true,
    trackWeb: true,       // browser domains (macOS reads the URL; Windows parses the title)
    trackTitles: false,   // send window titles for the live view (never stored in the DB)
    sampleSec: 5,
    idleThresholdSec: 180,
  },
  schedule: {
    enabled: false,       // only monitor during working hours (machine local time)
    days: [1, 2, 3, 4, 5],// 0 = Sunday
    start: '09:00',
    end: '18:00',
  },
  uploadIntervalMin: 10,  // agent batches data locally and uploads this often
  heartbeatSec: 120,      // presence ping (memory only on server)
  allowPause: false,      // let the employee pause monitoring from the tray
  maxPauseMin: 30,
  showNotice: true,       // show a one-time "this computer is monitored" notice
  stealth: false,         // silent mode: no tray icon, no notice, no windows on the employee's computer
  autoRestart: true,      // relaunch the agent if an employee kills it from Task Manager / Activity Monitor
  excludedApps: [],       // apps that are never tracked or screenshotted (e.g. password managers)
};

export const DEFAULT_ORG = { name: 'My Company', timezone: 'UTC' };
export const DEFAULT_RETENTION = { screenshotsDays: 30, activityDays: 180, auditDays: 90 };

export const state = {
  settings: { policy: DEFAULT_POLICY, org: DEFAULT_ORG, retention: DEFAULT_RETENTION, maintenance: {} },
  devices: new Map(),     // id -> device row
  presence: new Map(),    // id -> { lastSeen, ip, current, idleSec, paused, version }
  commands: new Map(),    // id -> [{ id, type, args }]
  rules: [],              // productivity rules
  employees: new Map(),   // id -> { id, name, department_id } (names for the live view)
  policyCache: new Map(), // deviceId -> { policy, version }
};

export function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isPlainObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export async function loadState() {
  const [settings, devices, rules, employees] = await Promise.all([
    query('SELECT key, value FROM settings'),
    query('SELECT * FROM devices'),
    query('SELECT id, kind, pattern, category FROM productivity_rules ORDER BY id'),
    query('SELECT id, name, department_id FROM employees'),
  ]);
  for (const r of settings.rows) state.settings[r.key] = r.value;
  state.settings.policy = deepMerge(DEFAULT_POLICY, state.settings.policy);
  state.settings.org = deepMerge(DEFAULT_ORG, state.settings.org);
  state.settings.retention = deepMerge(DEFAULT_RETENTION, state.settings.retention);
  state.devices = new Map(devices.rows.map((d) => [d.id, d]));
  state.rules = rules.rows;
  state.employees = new Map(employees.rows.map((e) => [e.id, e]));
  state.policyCache.clear();
}

export async function saveSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
  state.settings[key] = value;
  if (key === 'policy') state.policyCache.clear();
}

export function upsertDeviceCache(row) {
  state.devices.set(row.id, row);
  state.policyCache.delete(row.id);
}

export function effectivePolicy(deviceId) {
  const cached = state.policyCache.get(deviceId);
  if (cached) return cached;
  const dev = state.devices.get(deviceId);
  let policy = deepMerge(state.settings.policy, dev?.policy_override || {});
  if (dev?.status === 'disabled') policy = { ...policy, enabled: false };
  const version = crypto.createHash('sha1').update(JSON.stringify(policy)).digest('hex').slice(0, 12);
  const entry = { policy, version };
  state.policyCache.set(deviceId, entry);
  return entry;
}

export function queueCommand(deviceId, type, args = {}) {
  const list = state.commands.get(deviceId) || [];
  const cmd = { id: crypto.randomUUID(), type, args, at: Date.now() };
  list.push(cmd);
  state.commands.set(deviceId, list.slice(-20));
  return cmd;
}

export function takeCommands(deviceId) {
  const list = state.commands.get(deviceId) || [];
  state.commands.delete(deviceId);
  // drop stale commands (> 1 day)
  return list.filter((c) => Date.now() - c.at < 86400000);
}

// ---------- productivity classification (done in JS so it costs zero DB work) ----------
export function normalizeDomain(d) {
  return String(d || '').toLowerCase().replace(/^www\./, '').trim();
}

export function classify(app, domain) {
  const a = String(app || '').toLowerCase();
  const d = normalizeDomain(domain);
  let best = null;
  for (const r of state.rules) {
    const p = r.pattern.toLowerCase();
    if (r.kind === 'domain' && d && (d === p || d.endsWith(`.${p}`))) {
      if (!best || best.kind !== 'domain' || p.length > best.pattern.length) best = r;
    } else if (r.kind === 'app' && a && (a === p || a.includes(p)) && (!best || best.kind === 'app')) {
      if (!best || p.length > best.pattern.length) best = r;
    }
  }
  return best ? best.category : 0;
}

export const ONLINE_WINDOW_MS = 6 * 60 * 1000;

export function deviceView(d) {
  const p = state.presence.get(d.id);
  const lastSeen = p?.lastSeen || (d.last_seen ? new Date(d.last_seen).getTime() : null);
  const emp = d.employee_id ? state.employees.get(d.employee_id) : null;
  return {
    id: d.id,
    uuid: d.uuid,
    name: d.name,
    hostname: d.hostname,
    os: d.os,
    osVersion: d.os_version,
    agentVersion: p?.version || d.agent_version,
    osUser: d.os_user,
    employeeId: d.employee_id,
    employeeName: emp?.name || null,
    status: d.status,
    policyOverride: d.policy_override || {},
    enrolledAt: d.enrolled_at,
    lastSeen: lastSeen ? new Date(lastSeen).toISOString() : null,
    lastIp: p?.ip || d.last_ip,
    online: !!(lastSeen && Date.now() - lastSeen < ONLINE_WINDOW_MS),
    paused: !!p?.paused,
    idleSec: p?.idleSec ?? null,
    current: p?.current || null,
    lastShot: p?.shot || null,
    monitoring: p?.monitoring ?? null,
    permissions: p?.permissions || null,
    pendingCommands: (state.commands.get(d.id) || []).length,
  };
}
