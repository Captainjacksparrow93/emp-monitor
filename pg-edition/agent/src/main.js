// EmpMonitor desktop agent (Windows + macOS).
//
// What it does:
//  - samples the foreground app / website + keyboard-mouse idle time every few seconds,
//  - aggregates samples into 15-minute buckets locally,
//  - uploads one small batch every `uploadIntervalMin` minutes (offline queue on disk),
//  - takes screenshots on the configured interval and uploads them,
//  - sends a lightweight heartbeat for the live view and to receive policy changes / remote commands.
// It is visible to the user (tray / menu-bar icon + one-time notice) by design.
import {
  app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor, Notification, dialog, nativeImage, shell, systemPreferences,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store, findProvisioning } from './store.js';
import { request, ApiError } from './api.js';
import {
  Aggregator, inSchedule, extractDomain, appName, isExcluded, nextShotDelay, withTimeout,
} from './core.js';
import {
  enqueueBatch, enqueueScreenshot, drain, setRevokedHandler, queueStatus, clearQueue,
} from './queue.js';
import { captureScreens, screenPermission, accessibilityPermission } from './capture.js';
import { ensurePersistence, removePersistence } from './persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const asset = (f) => path.join(__dirname, '..', 'assets', f);
const isMac = process.platform === 'darwin';

const DEFAULT_POLICY = {
  enabled: true,
  screenshots: { enabled: true, intervalMin: 10, jitter: true, quality: 55, maxWidth: 1600, blur: false, allScreens: true, skipWhenIdle: true },
  activity: { trackApps: true, trackWeb: true, trackTitles: false, sampleSec: 5, idleThresholdSec: 180 },
  schedule: { enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
  uploadIntervalMin: 10,
  heartbeatSec: 120,
  allowPause: false,
  maxPauseMin: 30,
  showNotice: true,
  stealth: false, // when true: no tray icon, no notice, no windows or dialogs — runs silently
  autoRestart: true, // relaunch the agent if it is killed from Task Manager / Activity Monitor
  excludedApps: [],
};

// ---------------------------------------------------------------- state
let tray = null;
let enrollWin = null;
let policy = DEFAULT_POLICY;
let orgName = '';
let employeeName = '';
let agg = new Aggregator();
let pausedUntil = 0;
let locked = false;
let lastSample = Date.now();
let current = null;
let lastIdleSec = 0;
let started = false;
let activeWindowFn = null;
let lastShot = { at: 0, status: 'none', count: 0 }; // why the last screenshot attempt did/didn't produce an image
let screenAtStart = false;      // whether Screen Recording was granted when this process launched (macOS)
let relaunchedForPerm = false;  // guard so we relaunch at most once when the permission flips
const timers = {};

const pendingFile = () => path.join(app.getPath('userData'), 'pending.json');
const log = (...a) => console.log(new Date().toISOString(), ...a);

function effectivePolicy(p) {
  const merge = (a, b) => {
    const o = { ...a };
    for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] ? merge(a[k], v) : v;
    return o;
  };
  return merge(DEFAULT_POLICY, p || {});
}

/**
 * Stealth mode hides every visible trace of the agent (no tray/menu-bar icon, no notice,
 * no windows or dialogs). It can come from the server policy, or be forced at install time
 * for a silent deployment (enroll.json "stealth":true / the --stealth flag), which is sticky.
 * store.get('policy') covers the window before the live policy has been fetched on startup.
 */
function isStealth() {
  return !!(store.get('stealthForced') || policy.stealth || store.get('policy')?.stealth);
}

function monitoringState() {
  if (!policy.enabled) return 'disabled';
  if (pausedUntil > Date.now()) return 'paused';
  if (locked) return 'locked';
  if (!inSchedule(policy.schedule)) return 'offhours';
  return 'active';
}

const STATE_LABEL = {
  active: 'Monitoring active',
  paused: 'Monitoring paused',
  locked: 'Screen locked',
  offhours: 'Outside working hours',
  disabled: 'Monitoring disabled by administrator',
};

// ---------------------------------------------------------------- persistence of un-uploaded samples
function savePending() {
  try { fs.writeFileSync(pendingFile(), JSON.stringify(agg)); } catch { /* ignore */ }
}

function loadPending() {
  try { agg = Aggregator.fromJSON(JSON.parse(fs.readFileSync(pendingFile(), 'utf8'))); } catch { agg = new Aggregator(); }
}

// ---------------------------------------------------------------- activity sampling
async function getActiveWindow() {
  if (!activeWindowFn) {
    try {
      ({ activeWindow: activeWindowFn } = await import('get-windows'));
    } catch (e) {
      log('get-windows unavailable:', e.message);
      activeWindowFn = async () => undefined;
    }
  }
  try {
    return await withTimeout(activeWindowFn(isMac ? {
      accessibilityPermission: accessibilityPermission(),
      screenRecordingPermission: screenPermission(),
    } : undefined), 3000, undefined);
  } catch {
    return undefined;
  }
}

async function sample() {
  const now = Date.now();
  const elapsed = (now - lastSample) / 1000;
  lastSample = now;
  // After sleep / long stalls don't count the gap.
  const seconds = Math.min(elapsed, policy.activity.sampleSec * 2);
  const st = monitoringState();
  if (st !== 'active') {
    current = null;
    return;
  }
  lastIdleSec = powerMonitor.getSystemIdleTime();
  const idle = lastIdleSec >= policy.activity.idleThresholdSec;
  let appLabel = 'Computer use';
  let domain = '';
  let title = '';
  if (!idle && policy.activity.trackApps) {
    const win = await getActiveWindow();
    if (win) {
      appLabel = appName(win);
      domain = policy.activity.trackWeb ? extractDomain({ url: win.url, title: win.title, app: appLabel }) : '';
      title = String(win.title || '').slice(0, 200);
    }
    if (isExcluded(appLabel, policy.excludedApps)) {
      appLabel = 'Private';
      domain = '';
      title = '';
    }
  }
  agg.add({ ts: now, seconds, idle, app: appLabel, domain });
  current = idle ? null : { app: appLabel, domain, title };
}

function scheduleSample() {
  clearTimeout(timers.sample);
  timers.sample = setTimeout(async () => {
    try { await sample(); } catch (e) { log('sample error', e.message); }
    scheduleSample();
  }, policy.activity.sampleSec * 1000);
}

// ---------------------------------------------------------------- uploads
async function flushBatch() {
  if (agg.isEmpty()) return;
  const batch = agg.drain();
  savePending();
  await enqueueBatch(batch);
}

function scheduleUpload() {
  clearInterval(timers.upload);
  timers.upload = setInterval(() => flushBatch().catch((e) => log('batch error', e.message)), policy.uploadIntervalMin * 60 * 1000);
  clearInterval(timers.persist);
  timers.persist = setInterval(savePending, 60 * 1000);
}

// On macOS, Screen Recording access is bound to the process at launch. If the user grants it while
// the agent is already running, this process keeps getting empty frames even though the OS now
// reports "granted" — so we relaunch once to pick it up (what macOS's "Quit & Reopen" would do).
function maybeRelaunchForScreen() {
  if (!isMac || !app.isPackaged || relaunchedForPerm || screenAtStart || !screenPermission()) return;
  relaunchedForPerm = true;
  log('Screen Recording granted after launch — relaunching to apply');
  app.relaunch();
  shutdownWork().finally(() => app.exit(0));
}

// ---------------------------------------------------------------- screenshots
async function takeScreenshot({ force = false } = {}) {
  const s = policy.screenshots;
  const mark = (status, count = 0) => { lastShot = { at: Date.now(), status, count }; };
  if (!force && !s.enabled) return mark('disabled');
  if (monitoringState() !== 'active') return mark(monitoringState());
  if (!force && s.skipWhenIdle && powerMonitor.getSystemIdleTime() >= policy.activity.idleThresholdSec) return mark('idle');
  if ((current && isExcluded(current.app, policy.excludedApps)) || current?.app === 'Private') return mark('excluded');
  if (!screenPermission()) {
    log('screenshot skipped: no Screen Recording permission');
    return mark('no-permission');
  }
  let shots = await withTimeout(captureScreens(s), 20000, []);
  if (!shots.length) {
    // macOS can return empty frames right after launch or a permission change; retry once.
    await new Promise((r) => setTimeout(r, 800));
    shots = await withTimeout(captureScreens(s), 20000, []);
  }
  if (!shots.length) {
    log('screenshot: capture returned nothing');
    mark('empty');
    maybeRelaunchForScreen();
    return undefined;
  }
  const takenAt = Date.now();
  for (const [i, shot] of shots.entries()) {
    await enqueueScreenshot(shot.jpeg, {
      takenAt: takenAt + i, width: shot.width, height: shot.height, app: current?.app || '', domain: current?.domain || '',
    });
  }
  mark('ok', shots.length);
  return undefined;
}

function scheduleScreenshot() {
  clearTimeout(timers.shot);
  const s = policy.screenshots;
  timers.shot = setTimeout(async () => {
    try { await takeScreenshot(); } catch (e) { log('screenshot error', e.message); }
    scheduleScreenshot();
  }, nextShotDelay(s.intervalMin, s.jitter));
}

// ---------------------------------------------------------------- server sync
async function fetchConfig() {
  const cfg = await request('/config');
  policy = effectivePolicy(cfg.policy);
  orgName = cfg.orgName || '';
  employeeName = cfg.employeeName || '';
  store.set({ policy: cfg.policy, policyVersion: cfg.policyVersion, orgName, employeeName });
  applyPolicy();
}

function applyPolicy() {
  scheduleSample();
  scheduleUpload();
  scheduleScreenshot();
  scheduleHeartbeat();
  syncTray();
  maybeShowNotice();
  // Keep-alive only once the machine is enrolled; harmless to call repeatedly (acts only on change).
  if (store.isEnrolled()) ensurePersistence(!!policy.autoRestart).catch(() => {});
}

/** Create, refresh or remove the tray icon to match stealth mode. */
function syncTray() {
  if (isStealth()) {
    if (tray) { tray.destroy(); tray = null; }
    if (isMac) app.dock?.hide();
    return;
  }
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.on('click', () => tray.popUpContextMenu());
  }
  updateTray();
}

async function handleCommand(cmd) {
  log('command', cmd.type);
  switch (cmd.type) {
    case 'screenshot': await takeScreenshot({ force: true }); break;
    case 'pause': pausedUntil = Date.now() + (Number(cmd.args?.minutes) || 30) * 60000; updateTray(); break;
    case 'resume': pausedUntil = 0; updateTray(); break;
    case 'refresh-config': await fetchConfig(); break;
    case 'restart': await shutdownWork(); app.relaunch(); app.exit(0); break;
    case 'show-message':
      dialog.showMessageBox({ type: 'info', title: orgName || 'EmpMonitor', message: String(cmd.args?.text || '').slice(0, 1000) });
      break;
    case 'uninstall': await revoke('This computer has been removed from monitoring by your administrator.'); break;
    default: break;
  }
}

async function heartbeat() {
  try {
    const st = monitoringState();
    const res = await request('/heartbeat', {
      method: 'POST',
      json: {
        version: app.getVersion(),
        paused: st === 'paused',
        monitoring: st === 'active',
        idleSec: Math.round(powerMonitor.getSystemIdleTime()),
        current: st === 'active' ? current : null,
        permissions: isMac ? { screenRecording: screenPermission(), accessibility: accessibilityPermission() } : null,
        shot: { status: lastShot.status, count: lastShot.count, at: lastShot.at },
      },
    });
    maybeRelaunchForScreen(); // pick up a Screen Recording grant made while we were running
    if (res.policyVersion && res.policyVersion !== store.get('policyVersion')) await fetchConfig();
    for (const c of res.commands || []) await handleCommand(c).catch((e) => log('command failed', e.message));
    drain();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) await revoke('This computer is no longer authorised to report to the server.');
    else log('heartbeat failed', e.message);
  }
}

function scheduleHeartbeat() {
  clearInterval(timers.heartbeat);
  timers.heartbeat = setInterval(heartbeat, policy.heartbeatSec * 1000);
}

// ---------------------------------------------------------------- lifecycle
async function start() {
  if (started) return;
  started = true;
  policy = effectivePolicy(store.get('policy'));
  orgName = store.get('orgName') || '';
  employeeName = store.get('employeeName') || '';
  loadPending();
  lastSample = Date.now();
  screenAtStart = screenPermission();
  applyPolicy();
  await heartbeat();
  drain();
  log('agent started');
}

async function shutdownWork() {
  Object.values(timers).forEach((t) => { clearTimeout(t); clearInterval(t); });
  try { await flushBatch(); } catch { savePending(); }
}

async function revoke(message) {
  log('revoked:', message);
  started = false;
  Object.values(timers).forEach((t) => { clearTimeout(t); clearInterval(t); });
  store.clearEnrollment();
  await clearQueue().catch(() => {});
  try { fs.rmSync(pendingFile(), { force: true }); } catch { /* ignore */ }
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: false });
  await removePersistence(); // stop the keep-alive, otherwise the agent would relaunch itself
  if (!isStealth()) await dialog.showMessageBox({ type: 'info', title: 'EmpMonitor Agent', message }).catch(() => {});
  app.exit(0);
}

function maybeShowNotice() {
  if (isStealth() || !policy.showNotice || store.get('noticeShown')) return;
  store.set({ noticeShown: true });
  const parts = [];
  if (policy.activity.trackApps) parts.push('applications used');
  if (policy.activity.trackWeb) parts.push('websites visited (domain only)');
  parts.push('active and idle time');
  if (policy.screenshots.enabled) parts.push(`periodic screenshots (about every ${policy.screenshots.intervalMin} minutes)`);
  dialog.showMessageBox({
    type: 'info',
    title: 'This computer is monitored',
    message: `${orgName || 'Your organization'} monitors activity on this computer.`,
    detail: `Collected: ${parts.join(', ')}.${policy.schedule.enabled ? ` Only during working hours (${policy.schedule.start}–${policy.schedule.end}).` : ''}\n\nThe ${isMac ? 'menu bar' : 'tray'} icon shows the current status.`,
  }).catch(() => {});
}

// ---------------------------------------------------------------- tray
function trayIcon() {
  const img = nativeImage.createFromPath(asset(isMac ? 'trayTemplate.png' : 'tray.png'));
  if (isMac) img.setTemplateImage(true);
  return img;
}

function updateTray() {
  if (!tray) return;
  const st = monitoringState();
  const enrolled = store.isEnrolled();
  tray.setToolTip(`EmpMonitor — ${enrolled ? STATE_LABEL[st] : 'not connected'}`);
  const q = queueStatus();
  const pauseItems = [];
  if (enrolled && policy.allowPause) {
    if (st === 'paused') {
      pauseItems.push({ label: `Paused until ${new Date(pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, enabled: false });
      pauseItems.push({ label: 'Resume monitoring', click: () => { pausedUntil = 0; updateTray(); } });
    } else {
      for (const m of [15, 30, 60, 120].filter((x) => x <= policy.maxPauseMin)) {
        pauseItems.push({ label: `Pause for ${m} min`, click: () => { pausedUntil = Date.now() + m * 60000; updateTray(); heartbeat(); } });
      }
    }
    pauseItems.push({ type: 'separator' });
  }
  const menu = Menu.buildFromTemplate([
    { label: enrolled ? STATE_LABEL[st] : 'Not connected', enabled: false },
    ...(enrolled ? [{ label: `${orgName || 'Organization'}${employeeName ? ` · ${employeeName}` : ''}`, enabled: false }] : []),
    ...(q.batches + q.screenshots > 0 ? [{ label: `${q.batches + q.screenshots} item(s) waiting to upload`, enabled: false }] : []),
    { type: 'separator' },
    ...pauseItems,
    ...(!enrolled ? [{ label: 'Connect to server…', click: showEnrollWindow }] : []),
    ...(isMac && enrolled && (!screenPermission() || !accessibilityPermission()) ? [
      { label: 'Grant permissions…', click: () => openPrivacy(!screenPermission() ? 'screen' : 'accessibility') },
    ] : []),
    { label: 'About EmpMonitor Agent', click: showAbout },
    ...(!enrolled || !app.isPackaged ? [{ label: 'Quit', click: () => app.quit() }] : []),
  ]);
  tray.setContextMenu(menu);
}

function showAbout() {
  const q = queueStatus();
  dialog.showMessageBox({
    type: 'info',
    title: 'EmpMonitor Agent',
    message: `EmpMonitor Agent ${app.getVersion()}`,
    detail: [
      `Status: ${store.isEnrolled() ? STATE_LABEL[monitoringState()] : 'not connected'}`,
      `Server: ${store.get('serverUrl') || '—'}`,
      `Computer: ${os.hostname()}`,
      `Pending uploads: ${q.batches} batches, ${q.screenshots} screenshots`,
      q.lastError ? `Last upload error: ${q.lastError}` : '',
    ].filter(Boolean).join('\n'),
  }).catch(() => {});
}

function openPrivacy(pane) {
  const url = pane === 'screen'
    ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
  shell.openExternal(url);
}

// ---------------------------------------------------------------- enrollment
function normalizeUrl(u) {
  let s = String(u || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s;
}

async function enroll(serverUrl, code, { stealth = false } = {}) {
  const url = normalizeUrl(serverUrl);
  const res = await request('/enroll', {
    method: 'POST',
    serverUrl: url,
    auth: false,
    json: {
      code: String(code).trim().toUpperCase(),
      deviceUuid: store.get('deviceUuid'),
      hostname: os.hostname(),
      os: process.platform,
      osVersion: isMac ? process.getSystemVersion() : os.release(),
      osUser: os.userInfo().username,
      agentVersion: app.getVersion(),
    },
  });
  store.set({ serverUrl: url, deviceUuid: res.deviceUuid, policy: res.policy, policyVersion: res.policyVersion, deviceId: res.deviceId });
  // A stealth flag from the installer is sticky; the server policy's own stealth setting still applies on top.
  if (stealth) store.set({ stealthForced: true });
  store.setToken(res.token);
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  if (isMac) {
    // Trigger the macOS permission prompts once.
    systemPreferences.isTrustedAccessibilityClient(true);
    captureScreens({ maxWidth: 320, quality: 10 }).catch(() => {});
  }
  started = false;
  await start();
  try { await fetchConfig(); } catch { /* use enroll policy */ }
  updateTray();
  return res;
}

function showEnrollWindow() {
  if (enrollWin) { enrollWin.show(); enrollWin.focus(); return; }
  enrollWin = new BrowserWindow({
    width: 440,
    height: 520,
    resizable: false,
    maximizable: false,
    minimizable: false,
    title: 'EmpMonitor Agent',
    icon: asset('icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'ui', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  enrollWin.loadFile(path.join(__dirname, 'ui', 'enroll.html'));
  enrollWin.on('closed', () => { enrollWin = null; });
}

ipcMain.handle('info', () => {
  const p = findProvisioning();
  return { version: app.getVersion(), hostname: os.hostname(), serverUrl: store.get('serverUrl') || p?.serverUrl || '', code: p?.code || '' };
});

ipcMain.handle('enroll', async (e, { serverUrl, code }) => {
  try {
    await enroll(serverUrl, code);
    return {
      ok: true,
      orgName,
      platform: process.platform,
      permissions: { screen: screenPermission(), accessibility: accessibilityPermission() },
    };
  } catch (err) {
    let msg = err.message;
    if (err.status === 0) msg = `Cannot reach the server: ${err.message}`;
    return { ok: false, error: msg };
  }
});
ipcMain.handle('close-window', () => enrollWin?.close());
ipcMain.handle('open-privacy', (e, pane) => openPrivacy(pane));

// ---------------------------------------------------------------- boot
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (isStealth()) return;
    if (!store.isEnrolled()) showEnrollWindow();
    else showAbout();
  });

  app.whenReady().then(async () => {
    if (isMac) app.dock?.hide();
    syncTray(); // creates the tray icon unless stealth mode is already known from a previous run

    powerMonitor.on('lock-screen', () => { locked = true; updateTray(); });
    powerMonitor.on('unlock-screen', () => { locked = false; lastSample = Date.now(); updateTray(); });
    powerMonitor.on('suspend', () => { locked = true; savePending(); });
    powerMonitor.on('resume', () => { locked = false; lastSample = Date.now(); setTimeout(heartbeat, 5000); });
    powerMonitor.on('shutdown', () => savePending());

    setRevokedHandler(() => revoke('This computer is no longer authorised to report to the server.'));
    setInterval(() => { if (tray) updateTray(); }, 60 * 1000);

    if (store.isEnrolled()) {
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
      await start();
    } else {
      const prov = findProvisioning();
      if (prov) {
        try {
          await enroll(prov.serverUrl, prov.code, { stealth: prov.stealth });
          log(`enrolled automatically from ${prov.source}`);
          if (!isStealth() && Notification.isSupported()) {
            new Notification({ title: 'EmpMonitor Agent', body: `Connected to ${orgName || prov.serverUrl}` }).show();
          }
        } catch (e) {
          log('auto-enroll failed:', e.message);
          if (!isStealth()) showEnrollWindow();
        }
      } else if (!isStealth()) {
        // Not provisioned and not forced stealth: show the manual enrollment window.
        showEnrollWindow();
      }
    }
    syncTray();
  });

  // Keep running in the tray when the enrollment window is closed.
  app.on('window-all-closed', () => {});

  let quitting = false;
  app.on('before-quit', async (e) => {
    if (quitting || !started) return;
    e.preventDefault();
    quitting = true;
    await shutdownWork();
    app.exit(0);
  });
}
