// Pure logic (no Electron imports) so it can be unit-tested with plain Node.

export const BUCKET_MS = 15 * 60 * 1000; // all timezone offsets are multiples of 15 minutes

export const bucketOf = (ts) => Math.floor(ts / BUCKET_MS) * BUCKET_MS;

/**
 * Accumulates samples into 15-minute buckets. The server further rolls these up per hour,
 * so a whole working day for one machine is only a few dozen rows.
 */
export class Aggregator {
  constructor() {
    this.reset();
  }

  reset() {
    this.presence = new Map(); // bucket -> { ts, active, idle, first, last }
    this.activity = new Map(); // `${bucket}|${app}|${domain}` -> { ts, app, domain, seconds }
  }

  add({ ts, seconds, idle, app, domain }) {
    if (!seconds || seconds <= 0) return;
    const b = bucketOf(ts);
    const p = this.presence.get(b) || { ts: b, active: 0, idle: 0, first: ts, last: ts };
    if (idle) p.idle += seconds;
    else p.active += seconds;
    p.first = Math.min(p.first, ts - seconds * 1000);
    p.last = Math.max(p.last, ts);
    this.presence.set(b, p);
    if (!idle && app) {
      const key = `${b}|${app}|${domain || ''}`;
      const a = this.activity.get(key) || { ts: b, app, domain: domain || '', seconds: 0 };
      a.seconds += seconds;
      this.activity.set(key, a);
    }
  }

  isEmpty() {
    return this.presence.size === 0;
  }

  /** Take everything collected so far and start fresh. */
  drain() {
    const round = (x) => ({ ...x, active: Math.round(x.active), idle: Math.round(x.idle) });
    const out = {
      presence: [...this.presence.values()].map(round),
      activity: [...this.activity.values()].map((a) => ({ ...a, seconds: Math.round(a.seconds) })).filter((a) => a.seconds > 0),
    };
    this.reset();
    return out;
  }

  toJSON() {
    return { presence: [...this.presence.values()], activity: [...this.activity.values()] };
  }

  static fromJSON(j) {
    const a = new Aggregator();
    for (const p of j?.presence || []) a.presence.set(p.ts, p);
    for (const x of j?.activity || []) a.activity.set(`${x.ts}|${x.app}|${x.domain || ''}`, x);
    return a;
  }
}

const toMin = (hhmm) => {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Is `date` (local time) inside the policy's working-hours schedule? Supports overnight shifts. */
export function inSchedule(schedule, date = new Date()) {
  if (!schedule?.enabled) return true;
  const day = date.getDay();
  const mins = date.getHours() * 60 + date.getMinutes();
  const start = toMin(schedule.start);
  const end = toMin(schedule.end);
  const days = schedule.days || [];
  if (start <= end) return days.includes(day) && mins >= start && mins < end;
  // overnight (e.g. 22:00 - 06:00): the shift belongs to the day it starts on
  if (mins >= start) return days.includes(day);
  if (mins < end) return days.includes((day + 6) % 7);
  return false;
}

const DOMAIN_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|dev|app|ai|co|in|uk|de|fr|edu|gov|me|so|us|ca|au|tv|info|biz|xyz|cloud|site|tech|ly|gg))\b/i;
const BROWSERS = /chrome|chromium|firefox|edge|msedge|safari|brave|opera|vivaldi|arc|orion/i;

export function isBrowser(app) {
  return BROWSERS.test(app || '');
}

/** Extract a bare domain from a URL (preferred) or from a browser window title (fallback). */
export function extractDomain({ url, title, app }) {
  if (url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.hostname.replace(/^www\./, '').toLowerCase();
      return '';
    } catch { /* fall through */ }
  }
  if (!isBrowser(app) || !title) return '';
  const m = String(title).match(DOMAIN_RE);
  return m ? m[1].replace(/^www\./, '').toLowerCase() : '';
}

/** Normalise an app name (strip ".exe", trim). */
export function appName(win) {
  const raw = win?.owner?.name || win?.owner?.path?.split(/[\\/]/).pop() || '';
  return String(raw).replace(/\.exe$/i, '').trim().slice(0, 120) || 'Unknown';
}

export function isExcluded(app, excluded = []) {
  const a = String(app || '').toLowerCase();
  return excluded.some((x) => x && a.includes(String(x).toLowerCase()));
}

/** Next screenshot delay in ms: fixed interval, or a random moment inside each interval window. */
export function nextShotDelay(intervalMin, jitter, rand = Math.random) {
  const ms = Math.max(1, intervalMin) * 60 * 1000;
  if (!jitter) return ms;
  return Math.round(ms * (0.5 + rand())); // average stays = interval
}

export function backoff(attempt) {
  return Math.min(30 * 60 * 1000, 15000 * 2 ** Math.min(attempt, 7));
}

/** Resolve with `fallback` if `promise` doesn't settle within `ms` (native calls can hang). */
export function withTimeout(promise, ms, fallback) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve(fallback), ms); }),
  ]);
}
