// API client. VITE_API_URL points at the API server when the dashboard is hosted on Vercel.
export const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

let token = null;
try { token = localStorage.getItem('em_token'); } catch { /* storage blocked */ }

export function setToken(t) {
  token = t;
  try {
    if (t) localStorage.setItem('em_token', t);
    else localStorage.removeItem('em_token');
  } catch { /* ignore */ }
}

export function getToken() {
  return token;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, raw } = {}) {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && token && !path.startsWith('/auth/login')) {
    setToken(null);
    window.dispatchEvent(new Event('em:logout'));
  }
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  return data;
}

export const fileUrl = (url) => `${API_BASE}${url}`;

/** Download a CSV endpoint using the auth header. */
export async function downloadCsv(path, filename) {
  const res = await api(path, { raw: true });
  if (!res.ok) throw new ApiError(res.status, 'Download failed');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
