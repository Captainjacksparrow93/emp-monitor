// Write-behind ingest buffer.
//
// Agents upload small batches every few minutes. Instead of writing each batch to Postgres
// (which would keep a Neon compute awake all day), batches are merged in memory, persisted to
// a local append-only spool file (so a crash/restart loses nothing), and written to Postgres
// in ONE transaction every FLUSH_INTERVAL_MIN minutes using set-based UPSERTs.
//
// The flush is skipped entirely when there is nothing to write, and it is piggy-backed onto
// dashboard queries (the compute is awake anyway), so the dashboard always shows fresh data.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { tx, dbStats } from './db.js';
import { state } from './state.js';
import { localDayHour } from './tz.js';
import { invalidateCache } from './cache.js';

const SPOOL = path.join(config.dataDir, 'spool.jsonl');
const SPOOL_FLUSHING = path.join(config.dataDir, 'spool.flushing.jsonl');
const CHUNK = 4000;

function emptyBuffer() {
  return { devHours: new Map(), appHours: new Map(), shots: new Map(), seen: new Map() };
}

let buf = emptyBuffer();
const seenBatches = new Map(); // `${deviceId}:${batchId}` -> ts (de-duplicates agent retries)
let flushing = null;
let timer = null;

export const flushStats = {
  lastFlushAt: null,
  lastFlushMs: 0,
  lastFlushRows: 0,
  lastError: null,
  totalFlushes: 0,
  skippedEmpty: 0,
  nextFlushAt: null,
};

const clampInt = (v, min, max) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
const str = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function applyIngest(b, rec) {
  const tz = state.settings.org.timezone || 'UTC';
  const { deviceId, employeeId } = rec;
  for (const p of rec.presence || []) {
    const ts = Number(p.ts);
    if (!Number.isFinite(ts)) continue;
    const { day, hour } = localDayHour(ts, tz);
    const key = `${day}|${deviceId}|${hour}`;
    const first = Number(p.first) || ts;
    const last = Number(p.last) || ts;
    const cur = b.devHours.get(key);
    if (cur) {
      cur.active += clampInt(p.active, 0, 3600);
      cur.idle += clampInt(p.idle, 0, 3600);
      cur.first = Math.min(cur.first, first);
      cur.last = Math.max(cur.last, last);
      if (employeeId) cur.employeeId = employeeId;
    } else {
      b.devHours.set(key, {
        day, hour, deviceId, employeeId,
        active: clampInt(p.active, 0, 3600), idle: clampInt(p.idle, 0, 3600), first, last,
      });
    }
  }
  for (const a of rec.activity || []) {
    const ts = Number(a.ts);
    const seconds = clampInt(a.seconds, 0, 3600);
    if (!Number.isFinite(ts) || !seconds) continue;
    const app = str(a.app, 120) || 'Unknown';
    const domain = str(a.domain, 120).toLowerCase().replace(/^www\./, '');
    const { day, hour } = localDayHour(ts, tz);
    const key = `${day}|${deviceId}|${hour}|${app}|${domain}`;
    const cur = b.appHours.get(key);
    if (cur) {
      cur.seconds += seconds;
      if (employeeId) cur.employeeId = employeeId;
    } else {
      b.appHours.set(key, { day, hour, deviceId, employeeId, app, domain, seconds });
    }
  }
  const prev = b.seen.get(deviceId);
  if (!prev || rec.at >= prev.at) b.seen.set(deviceId, { at: rec.at, ip: rec.ip || '', version: rec.version || '' });
}

function applyShot(b, meta) {
  b.shots.set(meta.storageKey, meta);
}

function applyRecord(b, rec) {
  if (rec.t === 'ingest') applyIngest(b, rec);
  else if (rec.t === 'shot') applyShot(b, rec);
}

function appendSpool(rec) {
  fs.appendFileSync(SPOOL, `${JSON.stringify(rec)}\n`);
}

export function pendingRows(b = buf) {
  return b.devHours.size + b.appHours.size + b.shots.size;
}

export function bufferStats() {
  let spoolBytes = 0;
  try { spoolBytes = fs.statSync(SPOOL).size; } catch { /* none */ }
  return {
    pendingDeviceHours: buf.devHours.size,
    pendingAppHours: buf.appHours.size,
    pendingScreenshots: buf.shots.size,
    pendingRows: pendingRows(),
    spoolBytes,
    flushing: !!flushing,
    ...flushStats,
  };
}

/** Returns false when the batch was already received (agent retry). */
export function ingest({ deviceId, employeeId, batchId, presence, activity, ip, version }) {
  if (batchId) {
    const k = `${deviceId}:${batchId}`;
    if (seenBatches.has(k)) return false;
    seenBatches.set(k, Date.now());
    if (seenBatches.size > 50000) {
      const cutoff = Date.now() - 48 * 3600 * 1000;
      for (const [key, ts] of seenBatches) if (ts < cutoff) seenBatches.delete(key);
    }
  }
  const rec = {
    t: 'ingest', deviceId, employeeId: employeeId || null, batchId: batchId || null,
    presence: Array.isArray(presence) ? presence.slice(0, 2000) : [],
    activity: Array.isArray(activity) ? activity.slice(0, 20000) : [],
    ip, version, at: Date.now(),
  };
  appendSpool(rec);
  applyIngest(buf, rec);
  if (pendingRows() >= config.flushMaxRows) setImmediate(() => flush('max-rows').catch(() => {}));
  return true;
}

export function addScreenshotMeta(meta) {
  const rec = { t: 'shot', ...meta };
  appendSpool(rec);
  applyShot(buf, rec);
}

function replaySpoolFile(file, b) {
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      applyRecord(b, rec);
      if (rec.t === 'ingest' && rec.batchId) seenBatches.set(`${rec.deviceId}:${rec.batchId}`, rec.at);
      n += 1;
    } catch { /* skip corrupt line (e.g. partial write during crash) */ }
  }
  return n;
}

/** On startup: recover anything that was received but not yet written to Postgres. */
export function recoverSpool() {
  let n = 0;
  if (fs.existsSync(SPOOL_FLUSHING)) {
    n += replaySpoolFile(SPOOL_FLUSHING, buf);
    fs.appendFileSync(SPOOL, fs.readFileSync(SPOOL_FLUSHING));
    fs.unlinkSync(SPOOL_FLUSHING);
    // the flushing content is now inside SPOOL; reset and replay everything once
    buf = emptyBuffer();
    n = 0;
  }
  n += replaySpoolFile(SPOOL, buf);
  if (n) console.log(`[buffer] recovered ${n} spooled records (${pendingRows()} rows pending)`);
}

function cols(rows, picks) {
  return picks.map((fn) => rows.map(fn));
}

async function writeSnapshot(snap) {
  // Drop rows for devices deleted while their data was buffered (would violate FK).
  const alive = (r) => state.devices.has(r.deviceId);
  const devRows = [...snap.devHours.values()].filter(alive);
  const appRows = [...snap.appHours.values()].filter(alive);
  const shotRows = [...snap.shots.values()].filter(alive);
  const seenRows = [...snap.seen.entries()].filter(([id]) => state.devices.has(id));

  await tx(async (c) => {
    for (let i = 0; i < devRows.length; i += CHUNK) {
      const part = devRows.slice(i, i + CHUNK);
      await c.query(
        `INSERT INTO activity_device (day, hour, device_id, employee_id, active_s, idle_s, first_at, last_at)
         SELECT * FROM unnest($1::date[], $2::smallint[], $3::int[], $4::int[], $5::int[], $6::int[], $7::timestamptz[], $8::timestamptz[])
         ON CONFLICT (day, device_id, hour) DO UPDATE SET
           active_s = activity_device.active_s + EXCLUDED.active_s,
           idle_s   = activity_device.idle_s + EXCLUDED.idle_s,
           first_at = LEAST(activity_device.first_at, EXCLUDED.first_at),
           last_at  = GREATEST(activity_device.last_at, EXCLUDED.last_at),
           employee_id = COALESCE(EXCLUDED.employee_id, activity_device.employee_id)`,
        cols(part, [
          (r) => r.day, (r) => r.hour, (r) => r.deviceId, (r) => r.employeeId,
          (r) => Math.min(r.active, 3600), (r) => Math.min(r.idle, 3600),
          (r) => new Date(r.first).toISOString(), (r) => new Date(r.last).toISOString(),
        ]),
      );
    }
    for (let i = 0; i < appRows.length; i += CHUNK) {
      const part = appRows.slice(i, i + CHUNK);
      await c.query(
        `INSERT INTO activity_app (day, hour, device_id, employee_id, app, domain, seconds)
         SELECT * FROM unnest($1::date[], $2::smallint[], $3::int[], $4::int[], $5::text[], $6::text[], $7::int[])
         ON CONFLICT (day, device_id, hour, app, domain) DO UPDATE SET
           seconds = LEAST(activity_app.seconds + EXCLUDED.seconds, 3600),
           employee_id = COALESCE(EXCLUDED.employee_id, activity_app.employee_id)`,
        cols(part, [
          (r) => r.day, (r) => r.hour, (r) => r.deviceId, (r) => r.employeeId,
          (r) => r.app, (r) => r.domain, (r) => r.seconds,
        ]),
      );
    }
    for (let i = 0; i < shotRows.length; i += CHUNK) {
      const part = shotRows.slice(i, i + CHUNK);
      await c.query(
        `INSERT INTO screenshots (device_id, employee_id, taken_at, storage_key, bytes, width, height, app, domain)
         SELECT * FROM unnest($1::int[], $2::int[], $3::timestamptz[], $4::text[], $5::int[], $6::smallint[], $7::smallint[], $8::text[], $9::text[])
         ON CONFLICT (storage_key) DO NOTHING`,
        cols(part, [
          (r) => r.deviceId, (r) => r.employeeId || null, (r) => new Date(r.takenAt).toISOString(),
          (r) => r.storageKey, (r) => r.bytes || 0, (r) => r.width || 0, (r) => r.height || 0,
          (r) => r.app || '', (r) => r.domain || '',
        ]),
      );
    }
    if (seenRows.length) {
      await c.query(
        `UPDATE devices d SET
           last_seen = GREATEST(COALESCE(d.last_seen, v.ls), v.ls),
           last_ip = CASE WHEN v.ip <> '' THEN v.ip ELSE d.last_ip END,
           agent_version = CASE WHEN v.ver <> '' THEN v.ver ELSE d.agent_version END
         FROM unnest($1::int[], $2::timestamptz[], $3::text[], $4::text[]) AS v(id, ls, ip, ver)
         WHERE d.id = v.id`,
        [
          seenRows.map(([id]) => id),
          seenRows.map(([, s]) => new Date(s.at).toISOString()),
          seenRows.map(([, s]) => s.ip || ''),
          seenRows.map(([, s]) => s.version || ''),
        ],
      );
    }
  });

  for (const [id, s] of seenRows) {
    const d = state.devices.get(id);
    if (d) {
      d.last_seen = new Date(s.at);
      if (s.ip) d.last_ip = s.ip;
      if (s.version) d.agent_version = s.version;
    }
  }
  return devRows.length + appRows.length + shotRows.length;
}

/** Flush buffered data to Postgres. Never wakes the DB if there is nothing to write. */
export async function flush(reason = 'interval') {
  if (flushing) return flushing;
  if (pendingRows() === 0 && buf.seen.size === 0) {
    flushStats.skippedEmpty += 1;
    return 0;
  }
  flushing = (async () => {
    const started = Date.now();
    const snap = buf;
    buf = emptyBuffer();
    if (fs.existsSync(SPOOL)) fs.renameSync(SPOOL, SPOOL_FLUSHING);
    try {
      const rows = await writeSnapshot(snap);
      if (fs.existsSync(SPOOL_FLUSHING)) fs.unlinkSync(SPOOL_FLUSHING);
      Object.assign(flushStats, {
        lastFlushAt: new Date().toISOString(), lastFlushMs: Date.now() - started,
        lastFlushRows: rows, lastError: null, totalFlushes: flushStats.totalFlushes + 1,
      });
      invalidateCache();
      console.log(`[buffer] flushed ${rows} rows in ${Date.now() - started} ms (${reason})`);
      return rows;
    } catch (err) {
      // Put the snapshot back so nothing is lost; retried on the next flush.
      for (const rec of readSpoolRecords(SPOOL_FLUSHING)) applyRecord(buf, rec);
      if (fs.existsSync(SPOOL_FLUSHING)) {
        const pending = fs.existsSync(SPOOL) ? fs.readFileSync(SPOOL) : Buffer.alloc(0);
        fs.renameSync(SPOOL_FLUSHING, SPOOL);
        if (pending.length) fs.appendFileSync(SPOOL, pending);
      }
      flushStats.lastError = `${new Date().toISOString()}: ${err.message}`;
      console.error('[buffer] flush failed:', err.message);
      throw err;
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

function readSpoolRecords(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

/** Called before dashboard analytics queries: the DB is being woken anyway, so write pending data too. */
export async function flushIfPending() {
  if (pendingRows() === 0) return;
  try { await flush('piggyback'); } catch { /* dashboard still works on older data */ }
}

export function startFlushTimer(onAfterFlush) {
  const ms = Math.max(1, config.flushIntervalMin) * 60 * 1000;
  const tick = async () => {
    try {
      await flush('interval');
      await onAfterFlush?.();
    } catch { /* logged */ }
    flushStats.nextFlushAt = new Date(Date.now() + ms).toISOString();
    timer = setTimeout(tick, ms);
  };
  flushStats.nextFlushAt = new Date(Date.now() + ms).toISOString();
  timer = setTimeout(tick, ms);
}

export function stopFlushTimer() {
  if (timer) clearTimeout(timer);
}

export { dbStats };
