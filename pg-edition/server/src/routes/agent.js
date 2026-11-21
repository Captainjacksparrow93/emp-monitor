// Endpoints used by the desktop agent.
// Only /enroll touches Postgres (once per machine). Everything else is memory + spool + object storage.
import express from 'express';
import crypto from 'node:crypto';
import { query } from '../db.js';
import { state, effectivePolicy, takeCommands, upsertDeviceCache } from '../state.js';
import { requireDevice, signDevice, clientIp } from '../auth.js';
import { ingest, addScreenshotMeta } from '../buffer.js';
import { putObject } from '../storage.js';
import { localDayHour } from '../tz.js';

export const agentRouter = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const s = (v, n = 200) => String(v ?? '').slice(0, n);
const safeDecode = (v) => { try { return decodeURIComponent(v); } catch { return v; } };

agentRouter.post('/enroll', express.json({ limit: '32kb' }), async (req, res) => {
  const { code, hostname, os, osVersion, osUser, agentVersion } = req.body || {};
  let deviceUuid = String(req.body?.deviceUuid || '');
  if (!code) return res.status(400).json({ error: 'Enrollment code is required' });
  if (!UUID_RE.test(deviceUuid)) deviceUuid = crypto.randomUUID();

  const { rows } = await query(
    `UPDATE enroll_tokens SET uses_left = CASE WHEN uses_left IS NULL THEN NULL ELSE uses_left - 1 END
     WHERE code = $1 AND (uses_left IS NULL OR uses_left > 0) AND (expires_at IS NULL OR expires_at > now())
     RETURNING id, employee_id, label`,
    [String(code).trim().toUpperCase()],
  );
  if (!rows.length) return res.status(403).json({ error: 'Invalid or expired enrollment code' });
  const token = rows[0];

  const ins = await query(
    `INSERT INTO devices (uuid, name, hostname, os, os_version, os_user, agent_version, employee_id, last_ip, last_seen)
     VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (uuid) DO UPDATE SET hostname = EXCLUDED.hostname, os = EXCLUDED.os, os_version = EXCLUDED.os_version,
       os_user = EXCLUDED.os_user, agent_version = EXCLUDED.agent_version, status = 'active',
       token_version = devices.token_version + 1, last_ip = EXCLUDED.last_ip, last_seen = now(),
       employee_id = COALESCE(EXCLUDED.employee_id, devices.employee_id)
     RETURNING *`,
    [deviceUuid, s(hostname, 120) || 'Unnamed computer', s(os, 40), s(osVersion, 80), s(osUser, 80),
      s(agentVersion, 40), token.employee_id, clientIp(req)],
  );
  const device = ins.rows[0];
  upsertDeviceCache(device);
  await query(`INSERT INTO audit_log (action, detail) VALUES ('device.enrolled', $1)`,
    [JSON.stringify({ deviceId: device.id, hostname: device.hostname, token: token.label })]);
  const { policy, version } = effectivePolicy(device.id);
  return res.json({ token: signDevice(device), deviceId: device.id, deviceUuid, policy, policyVersion: version });
});

// Heartbeat: presence + pending commands + current policy version. Memory only.
agentRouter.post('/heartbeat', requireDevice, express.json({ limit: '16kb' }), (req, res) => {
  const b = req.body || {};
  const dev = req.device;
  const policy = effectivePolicy(dev.id);
  state.presence.set(dev.id, {
    lastSeen: Date.now(),
    ip: clientIp(req),
    version: s(b.version, 40),
    paused: !!b.paused,
    monitoring: b.monitoring !== false,
    idleSec: Number(b.idleSec) || 0,
    permissions: b.permissions && typeof b.permissions === 'object' ? b.permissions : null,
    shot: b.shot && typeof b.shot === 'object' ? { status: s(b.shot.status, 24), count: Number(b.shot.count) || 0, at: Number(b.shot.at) || 0 } : null,
    current: b.current ? {
      app: s(b.current.app, 120),
      domain: s(b.current.domain, 120),
      title: policy.policy.activity.trackTitles ? s(b.current.title, 200) : '',
    } : null,
  });
  res.json({ policyVersion: policy.version, commands: takeCommands(dev.id), serverTime: Date.now() });
});

agentRouter.get('/config', requireDevice, (req, res) => {
  const { policy, version } = effectivePolicy(req.device.id);
  const emp = req.device.employee_id ? state.employees.get(req.device.employee_id) : null;
  res.json({
    policy, policyVersion: version, deviceName: req.device.name, employeeName: emp?.name || null,
    orgName: state.settings.org.name,
  });
});

agentRouter.post('/ingest', requireDevice, express.json({ limit: '4mb' }), (req, res) => {
  const b = req.body || {};
  const dev = req.device;
  const accepted = ingest({
    deviceId: dev.id,
    employeeId: dev.employee_id,
    batchId: s(b.batchId, 64),
    presence: b.presence,
    activity: b.activity,
    ip: clientIp(req),
    version: s(b.version, 40),
  });
  const p = state.presence.get(dev.id) || {};
  state.presence.set(dev.id, { ...p, lastSeen: Date.now(), ip: clientIp(req) });
  res.json({ ok: true, duplicate: !accepted });
});

agentRouter.post('/screenshot', requireDevice, express.raw({ type: ['image/jpeg', 'image/png', 'application/octet-stream'], limit: '8mb' }), async (req, res) => {
  const dev = req.device;
  if (!Buffer.isBuffer(req.body) || req.body.length < 100) return res.status(400).json({ error: 'empty image' });
  const takenAt = Number(req.headers['x-taken-at']) || Date.now();
  const shotId = String(req.headers['x-shot-id'] || crypto.randomUUID()).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40);
  const { day } = localDayHour(takenAt, state.settings.org.timezone);
  const storageKey = `${dev.uuid}/${day}/${shotId}.jpg`;
  await putObject(storageKey, req.body, 'image/jpeg');
  addScreenshotMeta({
    deviceId: dev.id,
    employeeId: dev.employee_id,
    takenAt,
    storageKey,
    bytes: req.body.length,
    width: Math.min(32767, Number(req.headers['x-width']) || 0),
    height: Math.min(32767, Number(req.headers['x-height']) || 0),
    app: safeDecode(s(req.headers['x-app'], 300)).slice(0, 120),
    domain: s(req.headers['x-domain'], 120),
  });
  res.json({ ok: true, key: storageKey });
});
