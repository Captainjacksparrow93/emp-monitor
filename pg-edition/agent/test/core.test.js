import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Aggregator, bucketOf, inSchedule, extractDomain, appName, isExcluded, nextShotDelay,
} from '../src/core.js';

test('aggregator buckets activity and idle', () => {
  const a = new Aggregator();
  const t = bucketOf(Date.UTC(2026, 0, 5, 9, 0)) + 1000;
  a.add({ ts: t, seconds: 5, idle: false, app: 'Code', domain: '' });
  a.add({ ts: t + 5000, seconds: 5, idle: false, app: 'Code', domain: '' });
  a.add({ ts: t + 10000, seconds: 5, idle: true });
  a.add({ ts: t + 15 * 60 * 1000, seconds: 5, idle: false, app: 'Chrome', domain: 'github.com' });
  const out = a.drain();
  assert.equal(out.presence.length, 2);
  assert.equal(out.presence[0].active, 10);
  assert.equal(out.presence[0].idle, 5);
  assert.deepEqual(out.activity.map((x) => [x.app, x.seconds]), [['Code', 10], ['Chrome', 5]]);
  assert.ok(a.isEmpty());
});

test('aggregator survives JSON round trip', () => {
  const a = new Aggregator();
  a.add({ ts: Date.now(), seconds: 5, app: 'X' });
  const b = Aggregator.fromJSON(JSON.parse(JSON.stringify(a)));
  b.add({ ts: Date.now(), seconds: 5, app: 'X' });
  assert.equal(b.drain().activity[0].seconds, 10);
});

test('schedule', () => {
  const s = { enabled: true, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };
  assert.equal(inSchedule(s, new Date(2026, 0, 5, 10, 0)), true); // Monday
  assert.equal(inSchedule(s, new Date(2026, 0, 5, 18, 0)), false);
  assert.equal(inSchedule(s, new Date(2026, 0, 4, 10, 0)), false); // Sunday
  const night = { enabled: true, days: [1], start: '22:00', end: '06:00' };
  assert.equal(inSchedule(night, new Date(2026, 0, 5, 23, 0)), true); // Mon night
  assert.equal(inSchedule(night, new Date(2026, 0, 6, 3, 0)), true); // Tue early = Mon shift
  assert.equal(inSchedule(night, new Date(2026, 0, 7, 3, 0)), false);
  assert.equal(inSchedule({ enabled: false }), true);
});

test('domain extraction', () => {
  assert.equal(extractDomain({ url: 'https://www.GitHub.com/x/y' }), 'github.com');
  assert.equal(extractDomain({ url: 'chrome://settings' }), '');
  assert.equal(extractDomain({ app: 'Google Chrome', title: 'Pull requests · stackoverflow.com - Google Chrome' }), 'stackoverflow.com');
  assert.equal(extractDomain({ app: 'Word', title: 'report.docx' }), '');
});

test('app name + exclusions + jitter', () => {
  assert.equal(appName({ owner: { name: 'chrome.exe' } }), 'chrome');
  assert.equal(appName({ owner: { path: 'C:\\Program Files\\App\\thing.exe' } }), 'thing');
  assert.equal(isExcluded('1Password 8', ['1password']), true);
  assert.equal(isExcluded('Code', ['1password']), false);
  assert.equal(nextShotDelay(10, false), 600000);
  assert.equal(nextShotDelay(10, true, () => 0), 300000);
  assert.equal(nextShotDelay(10, true, () => 0.999999), 899999);
});

// ---- persistence builders (pure, no Electron) ----
test('persistence task/plist builders', async () => {
  const { buildWindowsTaskXml, buildMacPlist } = await import('../src/persistence.js');
  const win = buildWindowsTaskXml('C:\\Program Files\\EmpMonitor Agent\\EmpMonitor Agent.exe');
  assert.match(win, /<LogonTrigger>/);
  assert.match(win, /<Interval>PT1M<\/Interval>/);
  assert.match(win, /IgnoreNew/);
  assert.match(win, /EmpMonitor Agent\.exe/);
  assert.match(win, /S-1-5-32-545/); // runs for the interactive Users group
  const plist = buildMacPlist('/Applications/EmpMonitor Agent.app/Contents/MacOS/EmpMonitor Agent');
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /com\.empmonitor\.agent/);
  // XML-escapes special characters in the path
  assert.match(buildMacPlist('/tmp/a&b'), /a&amp;b/);
});
