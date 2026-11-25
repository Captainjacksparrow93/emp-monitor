// End-to-end smoke test. Needs a throwaway Postgres:
//   TEST_DATABASE_URL=postgresql://user:pass@localhost/empmonitor_test npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const DB = process.env.TEST_DATABASE_URL;
const PORT = 18080 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empmon-'));
let proc;
let adminToken;
let deviceToken;
let deviceId;

async function api(method, url, body, token = adminToken, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

before(async () => {
  if (!DB) return;
  // The test database is throwaway: start from an empty schema every run.
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  proc = spawn(process.execPath, [fileURLToPath(new URL('../src/index.js', import.meta.url))], {
    env: {
      ...process.env, DATABASE_URL: DB, JWT_SECRET: 'test-secret-test-secret', PORT: String(PORT),
      DATA_DIR: dataDir, FLUSH_INTERVAL_MIN: '60', DASHBOARD_DIR: '/nonexistent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server did not start')), 20000);
    proc.stdout.on('data', (d) => { if (String(d).includes('database ready')) { clearTimeout(to); resolve(); } });
  });
});

after(() => proc?.kill('SIGTERM'));

test('full flow', { skip: !DB && 'TEST_DATABASE_URL not set' }, async () => {
  let r = await api('GET', '/api/auth/status');
  if (r.body.setupRequired) {
    r = await api('POST', '/api/auth/setup', { email: 'admin@example.com', password: 'password123', name: 'Admin' });
    assert.equal(r.status, 200);
  }
  r = await api('POST', '/api/auth/login', { email: 'admin@example.com', password: 'password123' });
  assert.equal(r.status, 200);
  adminToken = r.body.token;

  r = await api('POST', '/api/people/employees', { name: 'Jane Doe', email: 'jane@example.com' });
  const empId = r.body.id;

  r = await api('POST', '/api/enroll-tokens', { label: 'test', employeeId: empId });
  assert.equal(r.status, 200);
  const code = r.body.code;

  r = await api('POST', '/api/agent/enroll', { code, hostname: 'TEST-PC', os: 'win32', osVersion: '10', agentVersion: '1.0.0' }, null);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  deviceToken = r.body.token;
  deviceId = r.body.deviceId;
  assert.ok(r.body.policy.screenshots);

  r = await api('POST', '/api/agent/heartbeat', { version: '1.0.0', current: { app: 'Code', domain: '' } }, deviceToken);
  assert.equal(r.status, 200);

  const now = Date.now();
  const batch = {
    batchId: 'b1',
    presence: [{ ts: now, active: 600, idle: 60, first: now - 660000, last: now }],
    activity: [{ ts: now, app: 'Code', domain: '', seconds: 400 }, { ts: now, app: 'Google Chrome', domain: 'youtube.com', seconds: 200 }],
  };
  r = await api('POST', '/api/agent/ingest', batch, deviceToken);
  assert.equal(r.body.duplicate, false);
  r = await api('POST', '/api/agent/ingest', batch, deviceToken);
  assert.equal(r.body.duplicate, true, 'retries are de-duplicated');

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(500, 1)]);
  r = await api('POST', '/api/agent/screenshot', jpeg, deviceToken, {
    'Content-Type': 'image/jpeg', 'X-Taken-At': String(now), 'X-Shot-Id': 'shot1', 'X-App': 'Code', 'X-Width': '100', 'X-Height': '50',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  r = await api('GET', '/api/system');
  assert.equal(r.status, 200);
  assert.ok(r.body.buffer.pendingRows >= 3, 'data is buffered, not yet in DB');
  assert.ok(r.body.db.sizeBytes > 0);

  // analytics piggy-backs a flush
  r = await api('GET', '/api/analytics/summary');
  assert.equal(r.status, 200);
  assert.equal(r.body.totals.active, 600);
  assert.equal(r.body.totals.productive, 400);
  assert.equal(r.body.totals.unproductive, 200);
  assert.equal(r.body.people[0].name, 'Jane Doe');

  r = await api('GET', '/api/screenshots');
  assert.equal(r.body.length, 1);
  const img = await fetch(BASE + r.body[0].url);
  assert.equal(img.status, 200);

  r = await api('GET', '/api/devices');
  assert.equal(r.body[0].online, true);
  assert.equal(r.body[0].employeeName, 'Jane Doe');

  r = await api('POST', `/api/devices/${deviceId}/commands`, { type: 'screenshot' });
  r = await api('POST', '/api/agent/heartbeat', { version: '1.0.0' }, deviceToken);
  assert.equal(r.body.commands[0].type, 'screenshot');

  r = await api('PATCH', `/api/devices/${deviceId}`, { policyOverride: { screenshots: { intervalMin: 3 } } });
  r = await api('GET', '/api/agent/config', null, deviceToken);
  assert.equal(r.body.policy.screenshots.intervalMin, 3);

  r = await api('GET', '/api/analytics/attendance?format=csv');
  assert.match(r.body, /Jane Doe/);

  r = await api('DELETE', `/api/devices/${deviceId}`);
  r = await api('POST', '/api/agent/heartbeat', {}, deviceToken);
  assert.equal(r.status, 401, 'revoked device is rejected');
});
