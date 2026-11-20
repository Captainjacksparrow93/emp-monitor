// Retention cleanup. Runs at most once a day and ONLY right after a flush (when the compute is
// already awake), so it never causes a separate Neon wake-up.
import { query } from './db.js';
import { state, saveSetting } from './state.js';
import { deleteObjects } from './storage.js';
import { invalidateCache } from './cache.js';

const DAY = 86400000;

export async function runCleanup({ force = false } = {}) {
  const last = state.settings.maintenance?.lastCleanupAt;
  if (!force && last && Date.now() - new Date(last).getTime() < DAY) return null;
  const r = state.settings.retention;
  const result = { screenshots: 0, activityRows: 0, auditRows: 0 };

  // Screenshots: delete in batches so a big backlog can't produce a huge transaction.
  for (;;) {
    const { rows } = await query(
      `DELETE FROM screenshots WHERE id IN (
         SELECT id FROM screenshots WHERE taken_at < now() - ($1::int || ' days')::interval LIMIT 2000)
       RETURNING storage_key`, [r.screenshotsDays]);
    if (!rows.length) break;
    await deleteObjects(rows.map((x) => x.storage_key)).catch((e) => console.error('[cleanup] storage', e.message));
    result.screenshots += rows.length;
    if (rows.length < 2000) break;
  }
  const a1 = await query(`DELETE FROM activity_app WHERE day < (now() - ($1::int || ' days')::interval)::date`, [r.activityDays]);
  const a2 = await query(`DELETE FROM activity_device WHERE day < (now() - ($1::int || ' days')::interval)::date`, [r.activityDays]);
  const a3 = await query(`DELETE FROM audit_log WHERE at < now() - ($1::int || ' days')::interval`, [r.auditDays]);
  await query(`DELETE FROM enroll_tokens WHERE expires_at < now() - interval '30 days' OR uses_left = 0`);
  result.activityRows = a1.rowCount + a2.rowCount;
  result.auditRows = a3.rowCount;

  await saveSetting('maintenance', { lastCleanupAt: new Date().toISOString(), lastResult: result });
  invalidateCache();
  console.log('[cleanup]', result);
  return result;
}
