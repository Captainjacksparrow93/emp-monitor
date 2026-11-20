import { net, app } from 'electron';
import { store } from './store.js';

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** HTTP helper using Chromium's network stack (honours system proxy settings and certificates). */
export async function request(pathname, { method = 'GET', json, body, headers = {}, serverUrl, auth = true, timeoutMs = 30000 } = {}) {
  const base = (serverUrl || store.get('serverUrl') || '').replace(/\/$/, '');
  if (!base) throw new ApiError(0, 'Server URL not configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const token = auth ? store.getToken() : null;
    const res = await net.fetch(`${base}/api/agent${pathname}`, {
      method,
      signal: ctrl.signal,
      headers: {
        'User-Agent': `EmpMonitorAgent/${app.getVersion()} (${process.platform})`,
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : body,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
    if (!res.ok) throw new ApiError(res.status, data?.error || `HTTP ${res.status}`, data?.code);
    return data;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, e.name === 'AbortError' ? 'Request timed out' : e.message);
  } finally {
    clearTimeout(t);
  }
}
