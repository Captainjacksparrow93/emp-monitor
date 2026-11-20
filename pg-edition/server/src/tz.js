const fmtCache = new Map();

function formatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
      });
    } catch {
      f = formatter('UTC');
    }
    fmtCache.set(tz, f);
  }
  return f;
}

/** Convert an epoch-ms timestamp into { day: 'YYYY-MM-DD', hour: 0-23 } in the given IANA zone. */
export function localDayHour(ts, tz) {
  const parts = formatter(tz).formatToParts(new Date(ts));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

export function todayIn(tz) {
  return localDayHour(Date.now(), tz).day;
}

export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
