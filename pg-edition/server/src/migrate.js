import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { query } from './db.js';

export async function migrate() {
  const sql = fs.readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
  await query(sql);
}

// Allow `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { assertConfig } = await import('./config.js');
  assertConfig();
  await migrate();
  console.log('Schema is up to date.');
  const { closePool } = await import('./db.js');
  await closePool();
}
