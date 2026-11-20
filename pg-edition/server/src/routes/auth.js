import express from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db.js';
import { signAdmin, requireAdmin, requireWrite } from '../auth.js';
import { ah, audit, httpError } from './util.js';

export const authRouter = express.Router();

let hasAdminCache = null; // avoid a DB query on every login-page load
const attempts = new Map(); // naive in-memory login rate limiting

async function hasAdmin() {
  if (hasAdminCache === true) return true;
  const { rows } = await query('SELECT 1 FROM admins LIMIT 1');
  hasAdminCache = rows.length > 0;
  return hasAdminCache;
}

authRouter.get('/status', ah(async (req, res) => {
  res.json({ setupRequired: !(await hasAdmin()) });
}));

authRouter.post('/setup', ah(async (req, res) => {
  if (await hasAdmin()) throw httpError(409, 'Setup already completed');
  const { email, password, name } = req.body || {};
  if (!email || !password || password.length < 8) throw httpError(400, 'Email and a password of 8+ characters are required');
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO admins (email, name, password_hash, role) VALUES (lower($1), $2, $3, 'admin') RETURNING id, email, name, role`,
    [email.trim(), name || '', hash],
  );
  hasAdminCache = true;
  res.json({ token: signAdmin(rows[0]), admin: rows[0] });
}));

authRouter.post('/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  const key = String(email || '').toLowerCase();
  const a = attempts.get(key) || { n: 0, until: 0 };
  if (a.until > Date.now()) throw httpError(429, 'Too many attempts, try again in a few minutes');
  const { rows } = await query('SELECT * FROM admins WHERE email = lower($1)', [String(email || '').trim()]);
  const admin = rows[0];
  if (!admin || !(await bcrypt.compare(String(password || ''), admin.password_hash))) {
    a.n += 1;
    if (a.n >= 5) { a.until = Date.now() + 5 * 60 * 1000; a.n = 0; }
    attempts.set(key, a);
    throw httpError(401, 'Invalid email or password');
  }
  attempts.delete(key);
  res.json({ token: signAdmin(admin), admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } });
}));

authRouter.get('/me', requireAdmin, (req, res) => res.json({ admin: req.admin }));

authRouter.get('/admins', requireAdmin, ah(async (req, res) => {
  const { rows } = await query('SELECT id, email, name, role, created_at FROM admins ORDER BY id');
  res.json(rows);
}));

authRouter.post('/admins', requireAdmin, requireWrite, ah(async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password || password.length < 8) throw httpError(400, 'Email and a password of 8+ characters are required');
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await query(
      `INSERT INTO admins (email, name, password_hash, role) VALUES (lower($1), $2, $3, $4) RETURNING id, email, name, role, created_at`,
      [email.trim(), name || '', hash, role === 'viewer' ? 'viewer' : 'admin'],
    );
    await audit(req, 'admin.created', { email });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw httpError(409, 'An account with this email already exists');
    throw e;
  }
}));

authRouter.patch('/admins/:id', requireAdmin, ah(async (req, res) => {
  const id = Number(req.params.id);
  const self = id === req.admin.id;
  if (!self && req.admin.role !== 'admin') throw httpError(403, 'Read-only account');
  const { name, role, password } = req.body || {};
  const sets = [];
  const vals = [];
  if (name !== undefined) { vals.push(name); sets.push(`name = $${vals.length}`); }
  if (role !== undefined && req.admin.role === 'admin' && !self) {
    vals.push(role === 'viewer' ? 'viewer' : 'admin');
    sets.push(`role = $${vals.length}`);
  }
  if (password) {
    if (password.length < 8) throw httpError(400, 'Password must be 8+ characters');
    vals.push(await bcrypt.hash(password, 10));
    sets.push(`password_hash = $${vals.length}`);
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(id);
  const { rows } = await query(
    `UPDATE admins SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, email, name, role, created_at`, vals);
  await audit(req, 'admin.updated', { id });
  return res.json(rows[0]);
}));

authRouter.delete('/admins/:id', requireAdmin, requireWrite, ah(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.admin.id) throw httpError(400, 'You cannot delete your own account');
  await query('DELETE FROM admins WHERE id = $1', [id]);
  await audit(req, 'admin.deleted', { id });
  res.json({ ok: true });
}));
