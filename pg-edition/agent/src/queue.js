// Offline-first upload queue. Batches and screenshots are written to disk first, then uploaded.
// If the network or server is down, data waits on disk and is retried with exponential backoff.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import { request, ApiError } from './api.js';
import { backoff } from './core.js';

const MAX_QUEUE_BYTES = 500 * 1024 * 1024; // never use more than ~500 MB of disk while offline

const dir = () => path.join(app.getPath('userData'), 'queue');

let running = false;
let attempt = 0;
let retryTimer = null;
let onRevoked = () => {};
let lastError = null;

export function setRevokedHandler(fn) {
  onRevoked = fn;
}

export function queueStatus() {
  let files = [];
  try { files = fs.readdirSync(dir()); } catch { /* empty */ }
  return {
    batches: files.filter((f) => f.endsWith('.batch.json')).length,
    screenshots: files.filter((f) => f.endsWith('.jpg')).length,
    lastError,
  };
}

async function enforceLimit() {
  let entries;
  try { entries = await fsp.readdir(dir()); } catch { return; }
  const stats = await Promise.all(entries.map(async (f) => ({ f, s: await fsp.stat(path.join(dir(), f)).catch(() => null) })));
  const files = stats.filter((x) => x.s).sort((a, b) => a.s.mtimeMs - b.s.mtimeMs);
  let total = files.reduce((n, x) => n + x.s.size, 0);
  // Drop the oldest screenshots first when offline for a very long time.
  for (const x of files) {
    if (total <= MAX_QUEUE_BYTES) break;
    if (x.f.endsWith('.jpg')) {
      await fsp.rm(path.join(dir(), x.f), { force: true });
      await fsp.rm(path.join(dir(), x.f.replace(/\.jpg$/, '.meta.json')), { force: true });
      total -= x.s.size;
    }
  }
}

export async function enqueueBatch(batch) {
  await fsp.mkdir(dir(), { recursive: true });
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const body = { batchId: id, version: app.getVersion(), ...batch };
  await fsp.writeFile(path.join(dir(), `${id}.batch.json`), JSON.stringify(body));
  kick();
}

export async function enqueueScreenshot(jpeg, meta) {
  await fsp.mkdir(dir(), { recursive: true });
  const id = `${meta.takenAt}-${crypto.randomUUID()}`;
  await fsp.writeFile(path.join(dir(), `${id}.jpg`), jpeg);
  await fsp.writeFile(path.join(dir(), `${id}.meta.json`), JSON.stringify({ ...meta, shotId: id.split('-').slice(1).join('-') }));
  await enforceLimit();
  kick();
}

async function uploadOne(file) {
  const full = path.join(dir(), file);
  if (file.endsWith('.batch.json')) {
    const json = JSON.parse(await fsp.readFile(full, 'utf8'));
    await request('/ingest', { method: 'POST', json });
    await fsp.rm(full, { force: true });
  } else if (file.endsWith('.jpg')) {
    const metaFile = full.replace(/\.jpg$/, '.meta.json');
    const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8').catch(() => '{}'));
    await request('/screenshot', {
      method: 'POST',
      body: await fsp.readFile(full),
      timeoutMs: 120000,
      headers: {
        'Content-Type': 'image/jpeg',
        'X-Taken-At': String(meta.takenAt || Date.now()),
        'X-Shot-Id': String(meta.shotId || ''),
        'X-App': encodeURIComponent(meta.app || ''),
        'X-Domain': meta.domain || '',
        'X-Width': String(meta.width || 0),
        'X-Height': String(meta.height || 0),
      },
    });
    await fsp.rm(full, { force: true });
    await fsp.rm(metaFile, { force: true });
  }
}

/** Upload everything in the queue (oldest first). */
export async function drain() {
  if (running) return;
  running = true;
  clearTimeout(retryTimer);
  try {
    let files = [];
    try { files = (await fsp.readdir(dir())).filter((f) => f.endsWith('.batch.json') || f.endsWith('.jpg')).sort(); } catch { /* none */ }
    for (const f of files) {
      try {
        await uploadOne(f);
      } catch (e) {
        const permanent = e instanceof ApiError && e.status >= 400 && e.status < 500
          && ![401, 408, 429].includes(e.status);
        const corrupt = e instanceof SyntaxError;
        if (!permanent && !corrupt) throw e;
        // Bad payload (e.g. corrupt file / too large) - drop it instead of blocking the queue forever.
        console.error('[queue] dropping rejected item', f, e.message);
        await fsp.rm(path.join(dir(), f), { force: true });
        await fsp.rm(path.join(dir(), f.replace(/\.jpg$/, '.meta.json')), { force: true });
      }
    }
    attempt = 0;
    lastError = null;
  } catch (e) {
    lastError = e.message;
    if (e instanceof ApiError && e.status === 401) {
      onRevoked(e);
      return;
    }
    attempt += 1;
    retryTimer = setTimeout(() => drain(), backoff(attempt));
  } finally {
    running = false;
  }
}

let kickTimer = null;
function kick() {
  clearTimeout(kickTimer);
  kickTimer = setTimeout(() => { if (!attempt) drain(); }, 2000);
}

export async function clearQueue() {
  await fsp.rm(dir(), { recursive: true, force: true });
}
