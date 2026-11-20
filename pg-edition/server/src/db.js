import pg from 'pg';
import { config } from './config.js';

// Return BIGINT/NUMERIC aggregates as JS numbers (all our sums fit comfortably).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// DATE -> 'YYYY-MM-DD' string (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);

/**
 * Neon free-tier notes
 * --------------------
 * - The compute auto-suspends after 5 minutes without activity. Every query (even `SELECT 1`)
 *   resets that timer, so this app never runs health-check / keep-alive queries.
 * - Idle pool connections are closed after PG_IDLE_TIMEOUT_MS so nothing holds the compute open.
 * - We track query counts and "wake-ups" (first query after >5 min of silence) so the System
 *   panel can show how often the compute is being woken.
 */
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: config.pgPoolMax,
  idleTimeoutMillis: config.pgIdleTimeoutMs,
  connectionTimeoutMillis: 15000, // a suspended Neon compute needs a moment to cold start
  allowExitOnIdle: false,
  ssl: /sslmode=(require|verify)/.test(config.databaseUrl) || /neon\.tech/.test(config.databaseUrl)
    ? { rejectUnauthorized: false }
    : undefined,
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

const SUSPEND_MS = 5 * 60 * 1000;
export const dbStats = {
  startedAt: Date.now(),
  queries: 0,
  wakeups: 0,
  lastQueryAt: 0,
  activeMs: 0, // estimated time the compute was kept awake by this server
  wakeHistory: [], // timestamps of the last 200 wake-ups
};

function track() {
  const now = Date.now();
  if (!dbStats.lastQueryAt || now - dbStats.lastQueryAt > SUSPEND_MS) {
    dbStats.wakeups += 1;
    dbStats.wakeHistory.push(now);
    if (dbStats.wakeHistory.length > 200) dbStats.wakeHistory.shift();
    dbStats.activeMs += SUSPEND_MS; // compute stays up ~5 min after the last query
  } else {
    dbStats.activeMs += now - dbStats.lastQueryAt;
  }
  dbStats.lastQueryAt = now;
  dbStats.queries += 1;
}

/** True when the compute is very likely awake right now (a query ran in the last ~4 minutes). */
export function dbProbablyAwake() {
  return dbStats.lastQueryAt && Date.now() - dbStats.lastQueryAt < 4 * 60 * 1000;
}

export async function query(text, params) {
  track();
  return pool.query(text, params);
}

export async function tx(fn) {
  track();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn({
      query: (t, p) => { dbStats.queries += 1; return client.query(t, p); },
    });
    await client.query('COMMIT');
    return res;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
