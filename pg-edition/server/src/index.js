import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
// Prefer IPv4: this container has no IPv6 route, and resolving a host's AAAA record first makes
// Node's fetch/WebSocket fail ("fetch failed" / network error) instead of using the working IPv4.
dns.setDefaultResultOrder('ipv4first');
import { config, assertConfig } from './config.js';
import { migrate } from './migrate.js';
import { closePool, query, runSchema } from './db.js';
import { loadState, state, saveSetting } from './state.js';
import { recoverSpool, startFlushTimer, stopFlushTimer, flush } from './buffer.js';
import { runCleanup } from './maintenance.js';
import { requireAdmin } from './auth.js';
import { streamObject, verifySignedKey } from './storage.js';
import { agentRouter } from './routes/agent.js';
import { authRouter } from './routes/auth.js';
import { devicesRouter, enrollRouter } from './routes/devices.js';
import { peopleRouter } from './routes/people.js';
import { analyticsRouter } from './routes/analytics.js';
import { screenshotsRouter } from './routes/screenshots.js';
import { settingsRouter } from './routes/settings.js';
import { systemRouter } from './routes/system.js';

assertConfig();

const STARTER_RULES = [
  ['app', 'Code', 1], ['app', 'Visual Studio', 1], ['app', 'IntelliJ', 1], ['app', 'Xcode', 1],
  ['app', 'Terminal', 1], ['app', 'iTerm', 1], ['app', 'PowerShell', 1], ['app', 'Excel', 1],
  ['app', 'Word', 1], ['app', 'PowerPoint', 1], ['app', 'Outlook', 1], ['app', 'Slack', 1],
  ['app', 'Microsoft Teams', 1], ['app', 'Zoom', 1], ['app', 'Figma', 1], ['app', 'Notion', 1],
  ['app', 'Spotify', -1], ['app', 'Steam', -1],
  ['domain', 'github.com', 1], ['domain', 'gitlab.com', 1], ['domain', 'stackoverflow.com', 1],
  ['domain', 'docs.google.com', 1], ['domain', 'mail.google.com', 1], ['domain', 'atlassian.net', 1],
  ['domain', 'notion.so', 1], ['domain', 'figma.com', 1], ['domain', 'linkedin.com', 0],
  ['domain', 'youtube.com', -1], ['domain', 'facebook.com', -1], ['domain', 'instagram.com', -1],
  ['domain', 'netflix.com', -1], ['domain', 'reddit.com', -1], ['domain', 'x.com', -1], ['domain', 'twitter.com', -1],
];

async function seedOnce() {
  if (state.settings.seeded) return;
  const vals = [];
  const params = [];
  STARTER_RULES.forEach(([k, p, c], i) => {
    params.push(k, p, c);
    vals.push(`($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`);
  });
  await query(`INSERT INTO productivity_rules (kind, pattern, category) VALUES ${vals.join(',')} ON CONFLICT DO NOTHING`, params);
  await saveSetting('seeded', true);
  const { rows } = await query('SELECT id, kind, pattern, category FROM productivity_rules ORDER BY id');
  state.rules = rows;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// CORS: the dashboard is usually hosted on a different origin (e.g. Vercel).
const allowed = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// Becomes true once migrations + state have loaded. Until then (e.g. a wrong DATABASE_URL or a
// Neon outage at boot) the API stays up and returns a clear 503 instead of the whole container
// crash-looping, which would make the host's proxy answer every request with an opaque 404.
let dbReady = false;
let dbError = null;

// Health check never touches the DB (so uptime monitors don't keep Neon awake).
app.get('/healthz', (req, res) => res.json({ ok: true, dbReady, dbError: dbReady ? null : dbError, uptime: process.uptime() }));

// Gate the API until the database is ready, with a clear message the dashboard can show.
app.use('/api', (req, res, next) => {
  if (dbReady) return next();
  return res.status(503).json({ error: 'Server is starting / cannot reach its database. Check DATABASE_URL and the Neon project, then restart.', detail: dbError });
});

// One-time data import (used once when moving the DB onto the VPS). Token-gated and refuses to run
// once the database already has an admin, so it can never clobber a live install. The body is raw
// SQL (data INSERTs + setval) generated from the old database; it runs as a single transaction.
app.post('/api/restore', express.text({ type: '*/*', limit: '64mb' }), async (req, res) => {
  if (!process.env.RESTORE_TOKEN || req.get('X-Restore-Token') !== process.env.RESTORE_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const chk = await query('SELECT count(*)::int AS n FROM admins');
    if (chk.rows[0].n > 0) return res.status(409).json({ error: 'database is not empty; refusing to restore' });
    await runSchema(String(req.body || ''));
    await loadState();
    const counts = await query(
      `SELECT (SELECT count(*) FROM admins) admins, (SELECT count(*) FROM employees) employees,
              (SELECT count(*) FROM devices) devices, (SELECT count(*) FROM productivity_rules) rules,
              (SELECT count(*) FROM screenshots) screenshots, (SELECT count(*) FROM activity_app) activity_app,
              (SELECT count(*) FROM activity_device) activity_device`,
    );
    return res.json({ ok: true, counts: counts.rows[0] });
  } catch (e) {
    console.error('[restore]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.use('/api/agent', agentRouter);

// Signed image URLs (used by <img> tags in the dashboard).
app.get(/^\/api\/files\/(.+)$/, (req, res, next) => {
  const key = req.params[0];
  if (!verifySignedKey(key, req.query.exp, req.query.sig)) return res.status(403).end();
  return streamObject(key, res).catch(next);
});

app.use('/api', express.json({ limit: '1mb' }));
app.use('/api/auth', authRouter);
app.use('/api/devices', requireAdmin, devicesRouter);
app.use('/api/enroll-tokens', requireAdmin, enrollRouter);
app.use('/api/people', requireAdmin, peopleRouter);
app.use('/api/analytics', requireAdmin, analyticsRouter);
app.use('/api/screenshots', requireAdmin, screenshotsRouter);
app.use('/api/settings', requireAdmin, settingsRouter);
app.use('/api/system', requireAdmin, systemRouter);
app.get('/api/live', requireAdmin, (req, res) => {
  // memory-only snapshot for the overview page
  res.json({ devices: state.devices.size, presence: [...state.presence.entries()].map(([id, p]) => ({ id, ...p })) });
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Optional: serve the built dashboard from the same server (when not using Vercel).
if (fs.existsSync(path.join(config.dashboardDir, 'index.html'))) {
  app.use(express.static(config.dashboardDir, { index: false, maxAge: '1h' }));
  app.get('*', (req, res) => res.sendFile(path.join(config.dashboardDir, 'index.html')));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error('[error]', req.method, req.path, err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

// Node throws an AggregateError (empty .message) when every resolved address fails, which hides the
// real cause. Surface the code, address and sub-errors so the dashboard/health check can show them.
function describeDbError(e, depth = 0) {
  if (!e || depth > 4) return '';
  const parts = [];
  if (e.code) parts.push(e.code);
  if (e.message) parts.push(e.message);
  if (Array.isArray(e.errors)) for (const sub of e.errors.slice(0, 3)) parts.push(describeDbError(sub, depth + 1));
  if (e.cause) parts.push(`cause: ${describeDbError(e.cause, depth + 1)}`); // undici "fetch failed" hides the real reason here
  if (e.address) parts.push(`${e.address}:${e.port || ''}`);
  return parts.filter(Boolean).join(' | ') || String(e);
}

async function initDb() {
  // Keep trying until the database is reachable; the HTTP server is already up and returns 503
  // in the meantime, so a bad DATABASE_URL or a Neon outage never crash-loops the container.
  let attempt = 0;
  for (;;) {
    try {
      await migrate();
      await loadState();
      await seedOnce();
      recoverSpool();
      startFlushTimer(() => runCleanup().catch((e) => console.error('[cleanup]', e.message)));
      dbReady = true;
      dbError = null;
      console.log('[boot] database ready; API fully available');
      return;
    } catch (e) {
      attempt += 1;
      dbError = describeDbError(e);
      const wait = Math.min(30000, 2000 * attempt);
      console.error(`[boot] database not ready (attempt ${attempt}): ${dbError} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function main() {
  const server = app.listen(config.port, () => {
    console.log(`[boot] EmpMonitor PG server listening on :${config.port} (flush every ${config.flushIntervalMin} min)`);
  });
  initDb(); // runs in the background; /healthz stays up so the proxy keeps routing to us

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] ${sig}: flushing buffered data...`);
    stopFlushTimer();
    server.close();
    try { await flush('shutdown'); } catch { /* data stays in spool and is recovered on next boot */ }
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('[boot] failed:', e);
  process.exit(1);
});
