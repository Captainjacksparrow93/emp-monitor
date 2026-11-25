import { config } from './config.js';

// Some hosts / VPS firewalls block outbound Postgres port 5432 and even the Neon WebSocket upgrade
// on 443, while ordinary HTTPS still works. So for a Neon database we talk to it over plain HTTPS
// (Neon's serverless `neon()` SQL-over-HTTP driver); any other Postgres uses node-postgres on 5432.
const isNeon = /neon\.tech/i.test(config.databaseUrl) && config.dbDriver !== 'pg';

/** Split a multi-statement SQL script into individual statements (our schema has no functions/$-quoting). */
function splitStatements(text) {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

let backend;

if (isNeon) {
  const { neon, types } = await import('@neondatabase/serverless');
  // Return BIGINT/NUMERIC aggregates as JS numbers; DATE as a 'YYYY-MM-DD' string.
  types.setTypeParser(20, (v) => Number(v));
  types.setTypeParser(1700, (v) => Number(v));
  types.setTypeParser(1082, (v) => v);
  const sql = neon(config.databaseUrl, { fullResults: true }); // each call is one HTTPS request on 443
  backend = {
    kind: 'neon-http',
    query: (text, params) => sql(text, params ?? []),
    tx: async (fn) => {
      // The only tx() caller (the buffer flush) issues write-only statements and ignores results,
      // so we collect the statements and run them as one HTTP transaction.
      const calls = [];
      await fn({ query: (t, p) => { calls.push(sql(t, p ?? [])); return Promise.resolve({ rows: [], rowCount: 0 }); } });
      if (calls.length) await sql.transaction(calls);
      return undefined;
    },
    runSchema: (text) => sql.transaction(splitStatements(text).map((s) => sql(s, []))),
    end: async () => {},
  };
  console.log('[db] using Neon serverless driver over HTTPS (port 443)');
} else {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  pg.types.setTypeParser(1082, (v) => v);
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax,
    idleTimeoutMillis: config.pgIdleTimeoutMs,
    connectionTimeoutMillis: 15000,
    allowExitOnIdle: false,
    ssl: /sslmode=(require|verify)/.test(config.databaseUrl) ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('error', (err) => console.error('[db] idle client error', err.message));
  backend = {
    kind: 'pg',
    query: (text, params) => pool.query(text, params),
    tx: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const res = await fn({ query: (t, p) => { dbStats.queries += 1; return client.query(t, p); } });
        await client.query('COMMIT');
        return res;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      } finally {
        client.release();
      }
    },
    runSchema: (text) => pool.query(text),
    end: () => pool.end(),
  };
  console.log('[db] using node-postgres driver (port 5432)');
}

const SUSPEND_MS = 5 * 60 * 1000;
export const dbStats = {
  startedAt: Date.now(),
  queries: 0,
  wakeups: 0,
  lastQueryAt: 0,
  activeMs: 0,
  wakeHistory: [],
};

function track() {
  const now = Date.now();
  if (!dbStats.lastQueryAt || now - dbStats.lastQueryAt > SUSPEND_MS) {
    dbStats.wakeups += 1;
    dbStats.wakeHistory.push(now);
    if (dbStats.wakeHistory.length > 200) dbStats.wakeHistory.shift();
    dbStats.activeMs += SUSPEND_MS;
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
  return backend.query(text, params);
}

export async function tx(fn) {
  track();
  return backend.tx(fn);
}

/** Run a multi-statement SQL script (used for migrations). */
export async function runSchema(text) {
  track();
  return backend.runSchema(text);
}

export async function closePool() {
  await backend.end();
}
