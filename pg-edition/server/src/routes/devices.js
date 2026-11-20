import express from 'express';
import crypto from 'node:crypto';
import { query } from '../db.js';
import { requireWrite } from '../auth.js';
import {
  state, deviceView, upsertDeviceCache, queueCommand, effectivePolicy, isPlainObject,
} from '../state.js';
import { ah, audit, httpError } from './util.js';
import { config } from '../config.js';

export const devicesRouter = express.Router();

// Device list is served from memory: no DB query (and no Neon wake-up) for the live view.
devicesRouter.get('/', (req, res) => {
  const list = [...state.devices.values()].map(deviceView)
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
  res.json(list);
});

devicesRouter.get('/:id', (req, res) => {
  const d = state.devices.get(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'Not found' });
  return res.json({ ...deviceView(d), effectivePolicy: effectivePolicy(d.id).policy });
});

devicesRouter.patch('/:id', requireWrite, ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!state.devices.has(id)) throw httpError(404, 'Not found');
  const { name, employeeId, status, policyOverride } = req.body || {};
  const sets = [];
  const vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (name !== undefined) add('name', String(name).slice(0, 120) || 'Unnamed computer');
  if (employeeId !== undefined) add('employee_id', employeeId ? Number(employeeId) : null);
  if (status !== undefined) {
    if (!['active', 'disabled'].includes(status)) throw httpError(400, 'Invalid status');
    add('status', status);
  }
  if (policyOverride !== undefined) {
    if (!isPlainObject(policyOverride)) throw httpError(400, 'policyOverride must be an object');
    add('policy_override', JSON.stringify(policyOverride));
  }
  if (!sets.length) return res.json(deviceView(state.devices.get(id)));
  vals.push(id);
  const { rows } = await query(`UPDATE devices SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  upsertDeviceCache(rows[0]);
  await audit(req, 'device.updated', { id, fields: Object.keys(req.body || {}) });
  return res.json(deviceView(rows[0]));
}));

devicesRouter.delete('/:id', requireWrite, ah(async (req, res) => {
  const id = Number(req.params.id);
  const purge = req.query.purge === '1';
  const d = state.devices.get(id);
  if (!d) throw httpError(404, 'Not found');
  if (purge) {
    // Removes device + all its activity/screenshot rows (cascade). Images are removed by retention cleanup.
    const { rows } = await query('SELECT storage_key FROM screenshots WHERE device_id = $1', [id]);
    await query('DELETE FROM devices WHERE id = $1', [id]);
    const { deleteObjects } = await import('../storage.js');
    deleteObjects(rows.map((r) => r.storage_key)).catch((e) => console.error('[storage]', e.message));
    state.devices.delete(id);
  } else {
    // Revoke: keep history, invalidate the token, stop monitoring.
    const { rows } = await query(
      `UPDATE devices SET status = 'disabled', token_version = token_version + 1 WHERE id = $1 RETURNING *`, [id]);
    queueCommand(id, 'uninstall');
    upsertDeviceCache(rows[0]);
  }
  state.presence.delete(id);
  await audit(req, purge ? 'device.purged' : 'device.revoked', { id, hostname: d.hostname });
  res.json({ ok: true });
}));

const COMMANDS = ['screenshot', 'pause', 'resume', 'refresh-config', 'restart', 'show-message'];
devicesRouter.post('/:id/commands', requireWrite, ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!state.devices.has(id)) throw httpError(404, 'Not found');
  const { type, args } = req.body || {};
  if (!COMMANDS.includes(type)) throw httpError(400, `type must be one of ${COMMANDS.join(', ')}`);
  const cmd = queueCommand(id, type, isPlainObject(args) ? args : {});
  res.json({ ok: true, command: cmd, note: 'Delivered on the next agent heartbeat' });
}));

// Bulk actions (apply a policy override / command to many machines)
devicesRouter.post('/bulk', requireWrite, ah(async (req, res) => {
  const { ids, action, policyOverride, employeeId, command } = req.body || {};
  if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'ids required');
  const valid = ids.map(Number).filter((i) => state.devices.has(i));
  if (action === 'command') {
    if (!COMMANDS.includes(command)) throw httpError(400, 'invalid command');
    valid.forEach((i) => queueCommand(i, command));
  } else if (action === 'policy') {
    if (!isPlainObject(policyOverride)) throw httpError(400, 'policyOverride required');
    const { rows } = await query('UPDATE devices SET policy_override = $1 WHERE id = ANY($2) RETURNING *',
      [JSON.stringify(policyOverride), valid]);
    rows.forEach(upsertDeviceCache);
  } else if (action === 'enable' || action === 'disable') {
    const { rows } = await query('UPDATE devices SET status = $1 WHERE id = ANY($2) RETURNING *',
      [action === 'enable' ? 'active' : 'disabled', valid]);
    rows.forEach(upsertDeviceCache);
  } else if (action === 'assign') {
    const { rows } = await query('UPDATE devices SET employee_id = $1 WHERE id = ANY($2) RETURNING *',
      [employeeId ? Number(employeeId) : null, valid]);
    rows.forEach(upsertDeviceCache);
  } else {
    throw httpError(400, 'unknown action');
  }
  await audit(req, 'device.bulk', { action, ids: valid });
  res.json({ ok: true, count: valid.length });
}));

// ---------------- enrollment codes ----------------
export const enrollRouter = express.Router();

function newCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(10)) s += alphabet[b % alphabet.length];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

enrollRouter.get('/', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT t.*, e.name AS employee_name FROM enroll_tokens t
     LEFT JOIN employees e ON e.id = t.employee_id ORDER BY t.id DESC`);
  res.json({
    tokens: rows,
    serverUrl: config.publicUrl || `${req.protocol}://${req.get('host')}`,
    downloads: config.downloads,
  });
}));

enrollRouter.post('/', requireWrite, ah(async (req, res) => {
  const { label, employeeId, usesLeft, expiresInDays } = req.body || {};
  const { rows } = await query(
    `INSERT INTO enroll_tokens (code, label, employee_id, uses_left, expires_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + ($5::int || ' days')::interval END)
     RETURNING *`,
    [newCode(), String(label || '').slice(0, 120), employeeId ? Number(employeeId) : null,
      usesLeft === null || usesLeft === undefined || usesLeft === '' ? null : Math.max(1, Number(usesLeft)),
      expiresInDays ? Number(expiresInDays) : null],
  );
  await audit(req, 'enroll.created', { label });
  res.json(rows[0]);
}));

enrollRouter.delete('/:id', requireWrite, ah(async (req, res) => {
  await query('DELETE FROM enroll_tokens WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));
