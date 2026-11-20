// Dashboard analytics. Every handler first flushes pending agent data (the compute is being
// woken anyway) and caches results for 60 s, so clicking around the dashboard costs very little.
import express from 'express';
import { query } from '../db.js';
import { state, classify } from '../state.js';
import { flushIfPending } from '../buffer.js';
import { cached } from '../cache.js';
import { todayIn } from '../tz.js';
import { ah, DATE_RE, httpError } from './util.js';

export const analyticsRouter = express.Router();
const TTL = 60 * 1000;

function filters(q) {
  const today = todayIn(state.settings.org.timezone);
  const from = DATE_RE.test(q.from || '') ? q.from : today;
  const to = DATE_RE.test(q.to || '') ? q.to : from;
  if (to < from) throw httpError(400, '"to" must be after "from"');
  const vals = [from, to];
  let where = 'a.day BETWEEN $1 AND $2';
  if (q.deviceId) { vals.push(Number(q.deviceId)); where += ` AND a.device_id = $${vals.length}`; }
  if (q.employeeId) { vals.push(Number(q.employeeId)); where += ` AND a.employee_id = $${vals.length}`; }
  if (q.departmentId) {
    vals.push(Number(q.departmentId));
    where += ` AND a.employee_id IN (SELECT id FROM employees WHERE department_id = $${vals.length})`;
  }
  return { from, to, where, vals, key: JSON.stringify([from, to, q.deviceId, q.employeeId, q.departmentId]) };
}

function subjectName(employeeId, deviceId) {
  if (employeeId && state.employees.get(employeeId)) return state.employees.get(employeeId).name;
  const d = state.devices.get(deviceId);
  return d ? `${d.name} (unassigned)` : `Device #${deviceId}`;
}

analyticsRouter.use(ah(async (req, res, next) => {
  await flushIfPending();
  next();
}));

analyticsRouter.get('/summary', ah(async (req, res) => {
  const f = filters(req.query);
  const data = await cached(`summary:${f.key}`, TTL, async () => {
    const [totals, hourly, apps, people] = await Promise.all([
      query(`SELECT COALESCE(SUM(active_s),0) AS active, COALESCE(SUM(idle_s),0) AS idle,
                    COUNT(DISTINCT device_id) AS devices, COUNT(DISTINCT employee_id) AS employees
             FROM activity_device a WHERE ${f.where}`, f.vals),
      query(`SELECT hour, SUM(active_s) AS active, SUM(idle_s) AS idle
             FROM activity_device a WHERE ${f.where} GROUP BY hour ORDER BY hour`, f.vals),
      query(`SELECT app, domain, employee_id, device_id, SUM(seconds) AS seconds
             FROM activity_app a WHERE ${f.where} GROUP BY app, domain, employee_id, device_id`, f.vals),
      query(`SELECT employee_id, device_id, SUM(active_s) AS active, SUM(idle_s) AS idle,
                    MIN(first_at) AS first_at, MAX(last_at) AS last_at, COUNT(DISTINCT day) AS days
             FROM activity_device a WHERE ${f.where} GROUP BY employee_id, device_id`, f.vals),
    ]);

    // Productivity + top apps/domains computed in JS from the aggregated rows.
    const prod = { productive: 0, neutral: 0, unproductive: 0 };
    const byApp = new Map();
    const byDomain = new Map();
    const subjProd = new Map();
    for (const r of apps.rows) {
      const cat = classify(r.app, r.domain);
      const bucket = cat === 1 ? 'productive' : cat === -1 ? 'unproductive' : 'neutral';
      prod[bucket] += r.seconds;
      const ak = r.app;
      const a = byApp.get(ak) || { name: ak, seconds: 0, category: classify(r.app, '') };
      a.seconds += r.seconds;
      byApp.set(ak, a);
      if (r.domain) {
        const d = byDomain.get(r.domain) || { name: r.domain, seconds: 0, category: classify('', r.domain) };
        d.seconds += r.seconds;
        byDomain.set(r.domain, d);
      }
      const sk = `${r.employee_id || 0}:${r.employee_id ? 0 : r.device_id}`;
      const sp = subjProd.get(sk) || { productive: 0, unproductive: 0, neutral: 0 };
      sp[bucket] += r.seconds;
      subjProd.set(sk, sp);
    }

    // Merge per-device rows into per-employee rows (an employee can have several machines).
    const subjects = new Map();
    for (const r of people.rows) {
      const sk = `${r.employee_id || 0}:${r.employee_id ? 0 : r.device_id}`;
      const s = subjects.get(sk) || {
        key: sk, employeeId: r.employee_id, deviceId: r.employee_id ? null : r.device_id,
        name: subjectName(r.employee_id, r.device_id), active: 0, idle: 0, firstAt: null, lastAt: null, days: 0,
      };
      s.active += r.active;
      s.idle += r.idle;
      s.days = Math.max(s.days, r.days);
      if (!s.firstAt || r.first_at < s.firstAt) s.firstAt = r.first_at;
      if (!s.lastAt || r.last_at > s.lastAt) s.lastAt = r.last_at;
      subjects.set(sk, s);
    }
    const peopleOut = [...subjects.values()].map((s) => {
      const p = subjProd.get(s.key) || { productive: 0, unproductive: 0, neutral: 0 };
      return { ...s, ...p, productivity: s.active ? Math.round((p.productive / s.active) * 100) : 0 };
    }).sort((a, b) => b.active - a.active);

    const t = totals.rows[0];
    const hours = Array.from({ length: 24 }, (_, h) => {
      const r = hourly.rows.find((x) => x.hour === h);
      return { hour: h, active: r?.active || 0, idle: r?.idle || 0 };
    });
    return {
      from: f.from,
      to: f.to,
      totals: { ...t, ...prod, productivity: t.active ? Math.round((prod.productive / t.active) * 100) : 0 },
      hourly: hours,
      topApps: [...byApp.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 15),
      topDomains: [...byDomain.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 15),
      people: peopleOut,
    };
  });
  res.json(data);
}));

// Day-by-day attendance (first activity / last activity / active / idle)
analyticsRouter.get('/attendance', ah(async (req, res) => {
  const f = filters(req.query);
  const data = await cached(`attendance:${f.key}`, TTL, async () => {
    const { rows } = await query(
      `SELECT day, employee_id, device_id, MIN(first_at) AS first_at, MAX(last_at) AS last_at,
              SUM(active_s) AS active, SUM(idle_s) AS idle
       FROM activity_device a WHERE ${f.where}
       GROUP BY day, employee_id, device_id ORDER BY day DESC`, f.vals);
    const merged = new Map();
    for (const r of rows) {
      const k = `${r.day}:${r.employee_id || 0}:${r.employee_id ? 0 : r.device_id}`;
      const m = merged.get(k) || {
        day: r.day, employeeId: r.employee_id, deviceId: r.employee_id ? null : r.device_id,
        name: subjectName(r.employee_id, r.device_id), firstAt: r.first_at, lastAt: r.last_at, active: 0, idle: 0,
      };
      m.active += r.active;
      m.idle += r.idle;
      if (r.first_at < m.firstAt) m.firstAt = r.first_at;
      if (r.last_at > m.lastAt) m.lastAt = r.last_at;
      merged.set(k, m);
    }
    return [...merged.values()];
  });
  if (req.query.format === 'csv') {
    const tz = state.settings.org.timezone;
    const fmt = (d) => new Date(d).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
    const hrs = (s) => (s / 3600).toFixed(2);
    const lines = ['Date,Name,First activity,Last activity,Active hours,Idle hours'];
    for (const r of data) {
      lines.push([r.day, `"${String(r.name).replace(/"/g, '""')}"`, fmt(r.firstAt), fmt(r.lastAt), hrs(r.active), hrs(r.idle)].join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${f.from}_${f.to}.csv"`);
    return res.send(lines.join('\n'));
  }
  return res.json(data);
}));

// Per-hour timeline for a single machine or employee on one day (top app per hour)
analyticsRouter.get('/timeline', ah(async (req, res) => {
  const f = filters(req.query);
  const data = await cached(`timeline:${f.key}`, TTL, async () => {
    const [dev, apps] = await Promise.all([
      query(`SELECT hour, SUM(active_s) AS active, SUM(idle_s) AS idle FROM activity_device a
             WHERE ${f.where} GROUP BY hour`, f.vals),
      query(`SELECT hour, app, domain, SUM(seconds) AS seconds FROM activity_app a
             WHERE ${f.where} GROUP BY hour, app, domain`, f.vals),
    ]);
    return Array.from({ length: 24 }, (_, h) => {
      const d = dev.rows.find((r) => r.hour === h);
      const list = apps.rows.filter((r) => r.hour === h)
        .map((r) => ({ app: r.app, domain: r.domain, seconds: r.seconds, category: classify(r.app, r.domain) }))
        .sort((a, b) => b.seconds - a.seconds);
      return { hour: h, active: d?.active || 0, idle: d?.idle || 0, apps: list.slice(0, 5) };
    });
  });
  res.json(data);
}));

// Full app/domain usage list with category (for the Activity page + CSV)
analyticsRouter.get('/usage', ah(async (req, res) => {
  const f = filters(req.query);
  const data = await cached(`usage:${f.key}`, TTL, async () => {
    const { rows } = await query(
      `SELECT app, domain, SUM(seconds) AS seconds, COUNT(DISTINCT device_id) AS devices
       FROM activity_app a WHERE ${f.where} GROUP BY app, domain ORDER BY seconds DESC LIMIT 1000`, f.vals);
    return rows.map((r) => ({ ...r, category: classify(r.app, r.domain) }));
  });
  if (req.query.format === 'csv') {
    const label = { 1: 'Productive', 0: 'Neutral', '-1': 'Unproductive' };
    const lines = ['Application,Domain,Hours,Machines,Category'];
    for (const r of data) {
      lines.push([`"${r.app.replace(/"/g, '""')}"`, r.domain, (r.seconds / 3600).toFixed(2), r.devices, label[r.category]].join(','));
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="usage_${f.from}_${f.to}.csv"`);
    return res.send(lines.join('\n'));
  }
  return res.json(data);
}));

// Apps/domains used in the last 14 days that have no productivity rule yet.
analyticsRouter.get('/unclassified', ah(async (req, res) => {
  const data = await cached('unclassified', TTL, async () => {
    const { rows } = await query(
      `SELECT app, domain, SUM(seconds) AS seconds FROM activity_app
       WHERE day >= (now() - interval '14 days')::date GROUP BY app, domain ORDER BY seconds DESC LIMIT 2000`);
    const apps = new Map();
    const domains = new Map();
    const has = (kind, name) => state.rules.some((r) => r.kind === kind && (kind === 'domain'
      ? name === r.pattern || name.endsWith(`.${r.pattern}`)
      : name.toLowerCase().includes(r.pattern.toLowerCase())));
    for (const r of rows) {
      if (r.domain) {
        if (!has('domain', r.domain)) domains.set(r.domain, (domains.get(r.domain) || 0) + r.seconds);
      } else if (!has('app', r.app)) {
        apps.set(r.app, (apps.get(r.app) || 0) + r.seconds);
      }
    }
    const top = (m) => [...m.entries()].map(([name, seconds]) => ({ name, seconds }))
      .sort((a, b) => b.seconds - a.seconds).slice(0, 50);
    return { apps: top(apps), domains: top(domains) };
  });
  res.json(data);
}));
