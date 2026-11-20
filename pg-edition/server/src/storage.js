// Screenshot storage. Images NEVER go into Postgres (Neon free = 0.5 GB).
// Driver "local": files under DATA_DIR/screenshots (needs a persistent disk).
// Driver "s3":    any S3-compatible bucket (Cloudflare R2 free tier = 10 GB, Backblaze B2, AWS S3...).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const LOCAL_ROOT = path.join(config.dataDir, 'screenshots');
let s3 = null;
let s3cmd = null;

export const storageDriver = config.s3.bucket ? 's3' : 'local';

async function getS3() {
  if (s3) return s3;
  let mod;
  try {
    mod = await import('@aws-sdk/client-s3');
  } catch {
    throw new Error('S3_BUCKET is set but @aws-sdk/client-s3 is not installed. Run: npm i @aws-sdk/client-s3');
  }
  s3cmd = mod;
  s3 = new mod.S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint || undefined,
    forcePathStyle: !!config.s3.endpoint,
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  });
  return s3;
}

function safeKey(key) {
  if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes('..')) throw new Error('invalid key');
  return key;
}

export async function putObject(key, buffer, contentType = 'image/jpeg') {
  safeKey(key);
  if (storageDriver === 's3') {
    const client = await getS3();
    await client.send(new s3cmd.PutObjectCommand({
      Bucket: config.s3.bucket, Key: key, Body: buffer, ContentType: contentType,
    }));
    return;
  }
  const file = path.join(LOCAL_ROOT, key);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, buffer);
}

/** Pipe an object to an express response. */
export async function streamObject(key, res) {
  safeKey(key);
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  if (storageDriver === 's3') {
    const client = await getS3();
    const out = await client.send(new s3cmd.GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
    res.setHeader('Content-Type', out.ContentType || 'image/jpeg');
    out.Body.pipe(res);
    return;
  }
  const file = path.join(LOCAL_ROOT, key);
  if (!fs.existsSync(file)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  fs.createReadStream(file).pipe(res);
}

export async function deleteObjects(keys) {
  if (!keys.length) return;
  if (storageDriver === 's3') {
    const client = await getS3();
    for (let i = 0; i < keys.length; i += 1000) {
      await client.send(new s3cmd.DeleteObjectsCommand({
        Bucket: config.s3.bucket,
        Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
      }));
    }
    return;
  }
  await Promise.all(keys.map((k) => fsp.rm(path.join(LOCAL_ROOT, safeKey(k)), { force: true })));
}

/** Local disk usage of stored screenshots (S3 usage comes from the DB metadata sum). */
export async function localUsageBytes() {
  if (storageDriver !== 'local') return null;
  let total = 0;
  async function walk(dir) {
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await fsp.stat(p)).size;
    }
  }
  await walk(LOCAL_ROOT);
  return total;
}

// ---- Signed, expiring image URLs (so <img src> works without exposing the admin JWT) ----
export function signKey(key, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(`${key}:${exp}`).digest('base64url');
  return `/api/files/${key}?exp=${exp}&sig=${sig}`;
}

export function verifySignedKey(key, exp, sig) {
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(`${key}:${exp}`).digest('base64url');
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
