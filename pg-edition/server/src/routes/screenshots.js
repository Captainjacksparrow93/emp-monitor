import express from 'express';
import { query } from '../db.js';
import { requireWrite } from '../auth.js';
import { state } from '../state.js';
import { flushIfPending } from '../buffer.js';
import { signKey, deleteObjects } from '../storage.js';
import { ah, audit, DATE_RE } from './util.js';

export const screenshotsRouter = express.Router();

screenshotsRouter.get('/', ah(async (req, res) => {
  await flushIfPending();
  const q = req.query;
  const vals = [];
  const where = [];
  const tz = state.settings.org.timezone;
  if (q.deviceId) { vals.push(Number(q.deviceId)); where.push(`device_id = $${vals.length}`); }
  if (q.employeeId) { vals.push(Number(q.employeeId)); where.push(`employee_id = $${vals.length}`); }
  if (DATE_RE.test(q.date || '')) {
    vals.push(q.date, tz);
    where.push(`(taken_at AT TIME ZONE $${vals.length})::date = $${vals.length - 1}::date`);
  }
  if (q.before) { vals.push(new Date(Number(q.before)).toISOString()); where.push(`taken_at < $${vals.length}`); }
  if (q.app) { vals.push(`%${q.app}%`); where.push(`(app ILIKE $${vals.length} OR domain ILIKE $${vals.length})`); }
  const limit = Math.min(200, Number(q.limit) || 48);
  vals.push(limit);
  const { rows } = await query(
    `SELECT id, device_id, employee_id, taken_at, storage_key, bytes, width, height, app, domain
     FROM screenshots ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY taken_at DESC LIMIT $${vals.length}`, vals);
  res.json(rows.map((r) => ({
    id: r.id,
    deviceId: r.device_id,
    deviceName: state.devices.get(r.device_id)?.name || `#${r.device_id}`,
    employeeId: r.employee_id,
    employeeName: r.employee_id ? state.employees.get(r.employee_id)?.name || null : null,
    takenAt: r.taken_at,
    bytes: r.bytes,
    width: r.width,
    height: r.height,
    app: r.app,
    domain: r.domain,
    url: signKey(r.storage_key),
  })));
}));

screenshotsRouter.delete('/:id', requireWrite, ah(async (req, res) => {
  const { rows } = await query('DELETE FROM screenshots WHERE id = $1 RETURNING storage_key', [Number(req.params.id)]);
  if (rows.length) await deleteObjects([rows[0].storage_key]);
  await audit(req, 'screenshot.deleted', { id: req.params.id });
  res.json({ ok: true });
}));
