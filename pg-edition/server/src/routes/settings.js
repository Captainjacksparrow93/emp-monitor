import express from 'express';
import { query } from '../db.js';
import { requireWrite } from '../auth.js';
import {
  state, saveSetting, deepMerge, DEFAULT_POLICY, isPlainObject, normalizeDomain,
} from '../state.js';
import { isValidTimezone } from '../tz.js';
import { invalidateCache } from '../cache.js';
import { ah, audit, httpError } from './util.js';
import { storageDriver } from '../storage.js';

export const settingsRouter = express.Router();

settingsRouter.get('/', (req, res) => {
  res.json({
    policy: state.settings.policy,
    defaultPolicy: DEFAULT_POLICY,
    org: state.settings.org,
    retention: state.settings.retention,
    storageDriver,
  });
});

function sanitizePolicy(p) {
  const out = deepMerge(DEFAULT_POLICY, p);
  const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d);
  out.screenshots.intervalMin = clamp(out.screenshots.intervalMin, 1, 240, 10);
  out.screenshots.quality = clamp(out.screenshots.quality, 10, 95, 55);
  out.screenshots.maxWidth = clamp(out.screenshots.maxWidth, 640, 3840, 1600);
  out.activity.sampleSec = clamp(out.activity.sampleSec, 2, 60, 5);
  out.activity.idleThresholdSec = clamp(out.activity.idleThresholdSec, 30, 3600, 180);
  out.uploadIntervalMin = clamp(out.uploadIntervalMin, 1, 120, 10);
  out.heartbeatSec = clamp(out.heartbeatSec, 30, 900, 120);
  out.maxPauseMin = clamp(out.maxPauseMin, 1, 480, 30);
  out.stealth = !!out.stealth;
  if (!Array.isArray(out.excludedApps)) out.excludedApps = [];
  out.excludedApps = out.excludedApps.map((s) => String(s).trim()).filter(Boolean).slice(0, 200);
  if (!Array.isArray(out.schedule.days)) out.schedule.days = [1, 2, 3, 4, 5];
  if (!/^\d{2}:\d{2}$/.test(out.schedule.start)) out.schedule.start = '09:00';
  if (!/^\d{2}:\d{2}$/.test(out.schedule.end)) out.schedule.end = '18:00';
  return out;
}

settingsRouter.put('/policy', requireWrite, ah(async (req, res) => {
  if (!isPlainObject(req.body)) throw httpError(400, 'Invalid policy');
  const policy = sanitizePolicy(req.body);
  await saveSetting('policy', policy);
  await audit(req, 'policy.updated', {});
  res.json(policy);
}));

settingsRouter.put('/org', requireWrite, ah(async (req, res) => {
  const { name, timezone } = req.body || {};
  if (timezone && !isValidTimezone(timezone)) throw httpError(400, 'Unknown timezone');
  const org = { ...state.settings.org, ...(name !== undefined && { name: String(name).slice(0, 120) }), ...(timezone && { timezone }) };
  await saveSetting('org', org);
  invalidateCache();
  await audit(req, 'org.updated', org);
  res.json(org);
}));

settingsRouter.put('/retention', requireWrite, ah(async (req, res) => {
  const r = req.body || {};
  const clamp = (v, d) => (Number.isFinite(Number(v)) ? Math.max(1, Math.min(3650, Math.round(Number(v)))) : d);
  const retention = {
    screenshotsDays: clamp(r.screenshotsDays, state.settings.retention.screenshotsDays),
    activityDays: clamp(r.activityDays, state.settings.retention.activityDays),
    auditDays: clamp(r.auditDays, state.settings.retention.auditDays),
  };
  await saveSetting('retention', retention);
  await audit(req, 'retention.updated', retention);
  res.json(retention);
}));

// ---------------- productivity rules ----------------
async function reloadRules() {
  const { rows } = await query('SELECT id, kind, pattern, category FROM productivity_rules ORDER BY id');
  state.rules = rows;
  invalidateCache();
}

settingsRouter.get('/rules', (req, res) => res.json(state.rules));

settingsRouter.post('/rules', requireWrite, ah(async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  for (const it of items) {
    const kind = it.kind === 'domain' ? 'domain' : 'app';
    const pattern = kind === 'domain' ? normalizeDomain(it.pattern).replace(/^https?:\/\//, '').split('/')[0] : String(it.pattern || '').trim();
    const category = [-1, 0, 1].includes(Number(it.category)) ? Number(it.category) : 0;
    if (!pattern) continue;
    await query(
      `INSERT INTO productivity_rules (kind, pattern, category) VALUES ($1, $2, $3)
       ON CONFLICT (kind, pattern) DO UPDATE SET category = EXCLUDED.category`, [kind, pattern.slice(0, 200), category]);
  }
  await reloadRules();
  res.json(state.rules);
}));

settingsRouter.delete('/rules/:id', requireWrite, ah(async (req, res) => {
  await query('DELETE FROM productivity_rules WHERE id = $1', [Number(req.params.id)]);
  await reloadRules();
  res.json(state.rules);
}));

settingsRouter.get('/audit', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT l.id, l.at, l.action, l.detail, a.email AS admin_email FROM audit_log l
     LEFT JOIN admins a ON a.id = l.admin_id ORDER BY l.at DESC LIMIT 200`);
  res.json(rows);
}));
