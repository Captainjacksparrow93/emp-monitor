import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Minimal .env loader (avoids an extra dependency).
function loadDotEnv() {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 8080),
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || '',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  flushIntervalMin: num(process.env.FLUSH_INTERVAL_MIN, 20),
  flushMaxRows: num(process.env.FLUSH_MAX_ROWS, 20000),
  dbDriver: process.env.DB_DRIVER || '', // 'pg' forces node-postgres even for a Neon URL
  pgPoolMax: num(process.env.PG_POOL_MAX, 4),
  pgIdleTimeoutMs: num(process.env.PG_IDLE_TIMEOUT_MS, 10000),
  dbStorageLimitMb: num(process.env.DB_STORAGE_LIMIT_MB, 512),
  neonApiKey: process.env.NEON_API_KEY || '',
  neonProjectId: process.env.NEON_PROJECT_ID || '',
  s3: {
    bucket: process.env.S3_BUCKET || '',
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  },
  downloads: {
    win: process.env.AGENT_DOWNLOAD_WIN || '',
    mac: process.env.AGENT_DOWNLOAD_MAC || '',
  },
  dashboardDir: path.resolve(process.env.DASHBOARD_DIR || fileURLToPath(new URL('../../dashboard/dist', import.meta.url))),
};

export function assertConfig() {
  const missing = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (!config.jwtSecret || config.jwtSecret.length < 16) missing.push('JWT_SECRET (min 16 chars)');
  if (missing.length) {
    console.error(`Missing required configuration: ${missing.join(', ')}. See .env.example`);
    process.exit(1);
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
}
