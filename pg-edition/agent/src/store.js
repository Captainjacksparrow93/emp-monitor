// Persistent agent state in the per-user app data folder. The device token is encrypted with the
// OS keychain (Windows DPAPI / macOS Keychain) via Electron safeStorage when available.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { app, safeStorage } from 'electron';

const file = () => path.join(app.getPath('userData'), 'agent.json');

let data = null;

function load() {
  if (data) return data;
  try {
    data = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    data = {};
  }
  if (!data.deviceUuid) data.deviceUuid = crypto.randomUUID();
  return data;
}

function persist() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file());
}

export const store = {
  get(key) {
    return load()[key];
  },
  set(patch) {
    Object.assign(load(), patch);
    persist();
  },
  getToken() {
    const d = load();
    if (d.tokenEnc && safeStorage.isEncryptionAvailable()) {
      try { return safeStorage.decryptString(Buffer.from(d.tokenEnc, 'base64')); } catch { return null; }
    }
    return d.token || null;
  },
  setToken(token) {
    const d = load();
    if (token && safeStorage.isEncryptionAvailable()) {
      d.tokenEnc = safeStorage.encryptString(token).toString('base64');
      delete d.token;
    } else {
      d.token = token || undefined;
      delete d.tokenEnc;
    }
    persist();
  },
  clearEnrollment() {
    const d = load();
    delete d.token;
    delete d.tokenEnc;
    delete d.policy;
    delete d.policyVersion;
    persist();
  },
  isEnrolled() {
    return !!(load().serverUrl && this.getToken());
  },
};

/** Look for pre-provisioned enrollment (mass deployment): CLI args, then enroll.json files. */
export function findProvisioning(argv = process.argv) {
  const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  if (arg('server') && arg('code')) return { serverUrl: arg('server'), code: arg('code'), source: 'command line' };
  const candidates = [
    path.join(path.dirname(process.execPath), 'enroll.json'),
    process.platform === 'win32'
      ? path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'EmpMonitorAgent', 'enroll.json')
      : path.join('/Library/Application Support/EmpMonitorAgent/enroll.json'),
    path.join(os.homedir(), '.empmonitor-enroll.json'),
  ];
  for (const f of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.serverUrl && j.code) return { serverUrl: j.serverUrl, code: j.code, source: f };
    } catch { /* not there */ }
  }
  return null;
}
