import { query } from '../db.js';

/** Wrap async handlers so errors reach the error middleware. */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export async function audit(req, action, detail = {}) {
  try {
    await query('INSERT INTO audit_log (admin_id, action, detail) VALUES ($1, $2, $3)',
      [req.admin?.id || null, action, JSON.stringify(detail)]);
  } catch (e) {
    console.error('[audit]', e.message);
  }
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
