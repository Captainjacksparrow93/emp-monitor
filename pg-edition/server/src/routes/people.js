import express from 'express';
import { query } from '../db.js';
import { requireWrite } from '../auth.js';
import { state } from '../state.js';
import { ah, audit, httpError } from './util.js';

export const peopleRouter = express.Router();

async function refreshEmployees() {
  const { rows } = await query('SELECT id, name, department_id FROM employees');
  state.employees = new Map(rows.map((e) => [e.id, e]));
}

peopleRouter.get('/employees', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT e.*, d.name AS department_name FROM employees e
     LEFT JOIN departments d ON d.id = e.department_id ORDER BY e.name`);
  const deviceCount = new Map();
  for (const dev of state.devices.values()) {
    if (dev.employee_id) deviceCount.set(dev.employee_id, (deviceCount.get(dev.employee_id) || 0) + 1);
  }
  res.json(rows.map((r) => ({ ...r, device_count: deviceCount.get(r.id) || 0 })));
}));

peopleRouter.post('/employees', requireWrite, ah(async (req, res) => {
  const { name, email, departmentId, active } = req.body || {};
  if (!name) throw httpError(400, 'Name is required');
  const { rows } = await query(
    'INSERT INTO employees (name, email, department_id, active) VALUES ($1, $2, $3, $4) RETURNING *',
    [String(name).slice(0, 120), email || null, departmentId ? Number(departmentId) : null, active !== false],
  );
  await refreshEmployees();
  await audit(req, 'employee.created', { id: rows[0].id, name });
  res.json(rows[0]);
}));

peopleRouter.patch('/employees/:id', requireWrite, ah(async (req, res) => {
  const { name, email, departmentId, active } = req.body || {};
  const { rows } = await query(
    `UPDATE employees SET
       name = COALESCE($1, name), email = CASE WHEN $2::boolean THEN $3 ELSE email END,
       department_id = CASE WHEN $4::boolean THEN $5::int ELSE department_id END,
       active = COALESCE($6, active)
     WHERE id = $7 RETURNING *`,
    [name ?? null, email !== undefined, email || null, departmentId !== undefined,
      departmentId ? Number(departmentId) : null, active ?? null, Number(req.params.id)],
  );
  if (!rows.length) throw httpError(404, 'Not found');
  await refreshEmployees();
  await audit(req, 'employee.updated', { id: rows[0].id });
  res.json(rows[0]);
}));

peopleRouter.delete('/employees/:id', requireWrite, ah(async (req, res) => {
  const id = Number(req.params.id);
  await query('DELETE FROM employees WHERE id = $1', [id]);
  for (const d of state.devices.values()) if (d.employee_id === id) d.employee_id = null;
  state.policyCache.clear();
  await refreshEmployees();
  await audit(req, 'employee.deleted', { id });
  res.json({ ok: true });
}));

peopleRouter.get('/departments', ah(async (req, res) => {
  const { rows } = await query(
    `SELECT d.*, (SELECT count(*) FROM employees e WHERE e.department_id = d.id)::int AS employee_count
     FROM departments d ORDER BY d.name`);
  res.json(rows);
}));

peopleRouter.post('/departments', requireWrite, ah(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw httpError(400, 'Name is required');
  try {
    const { rows } = await query('INSERT INTO departments (name) VALUES ($1) RETURNING *', [name]);
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') throw httpError(409, 'Department already exists');
    throw e;
  }
}));

peopleRouter.patch('/departments/:id', requireWrite, ah(async (req, res) => {
  const { rows } = await query('UPDATE departments SET name = $1 WHERE id = $2 RETURNING *',
    [String(req.body?.name || '').trim(), Number(req.params.id)]);
  res.json(rows[0]);
}));

peopleRouter.delete('/departments/:id', requireWrite, ah(async (req, res) => {
  await query('DELETE FROM departments WHERE id = $1', [Number(req.params.id)]);
  await refreshEmployees();
  res.json({ ok: true });
}));
