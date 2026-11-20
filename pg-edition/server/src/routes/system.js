// "Backend panel": database size vs. the Neon free-tier quota, Neon compute usage, buffer state.
import express from 'express';
import { query, dbStats, dbProbablyAwake } from '../db.js';
import { config } from '../config.js';
import { requireWrite } from '../auth.js';
import { state } from '../state.js';
import { bufferStats, flush } from '../buffer.js';
import { cached } from '../cache.js';
import { storageDriver, localUsageBytes } from '../storage.js';
import { runCleanup } from '../maintenance.js';
import { ah, audit } from './util.js';

export const systemRouter = express.Router();

// Neon Free plan quotas (override with env if your plan differs).
const NEON_CU_HOURS_LIMIT = Number(process.env.NEON_CU_HOURS_LIMIT || 100);

async function neonInfo() {
  if (!config.neonApiKey || !config.neonProjectId) return { configured: false };
  return cached('neon', 10 * 60 * 1000, async () => {
    const h = { Authorization: `Bearer ${config.neonApiKey}`, Accept: 'application/json' };
    const base = `https://console.neon.tech/api/v2/projects/${config.neonProjectId}`;
    try {
      const [p, e] = await Promise.all([
        fetch(base, { headers: h }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Neon API ${r.status}`)))),
        fetch(`${base}/endpoints`, { headers: h }).then((r) => (r.ok ? r.json() : { endpoints: [] })),
      ]);
      const proj = p.project || {};
      const computeSeconds = proj.compute_time_seconds ?? proj.cpu_used_sec ?? null;
      return {
        configured: true,
        projectName: proj.name,
        region: proj.region_id,
        pgVersion: proj.pg_version,
        periodStart: proj.consumption_period_start,
        periodEnd: proj.consumption_period_end,
        computeTimeSeconds: computeSeconds,
        activeTimeSeconds: proj.active_time_seconds ?? null,
        // compute_time_seconds is CU-seconds (CU x seconds awake)
        cuHoursUsed: computeSeconds != null ? computeSeconds / 3600 : null,
        cuHoursLimit: NEON_CU_HOURS_LIMIT,
        syntheticStorageBytes: proj.synthetic_storage_size ?? null,
        writtenDataBytes: proj.written_data_bytes ?? null,
        dataTransferBytes: proj.data_transfer_bytes ?? null,
        endpoints: (e.endpoints || []).map((x) => ({
          id: x.id,
          type: x.type,
          state: x.current_state,
          minCu: x.autoscaling_limit_min_cu,
          maxCu: x.autoscaling_limit_max_cu,
          suspendTimeoutSeconds: x.suspend_timeout_seconds,
          lastActive: x.last_active,
          pooler: x.pooler_enabled,
        })),
      };
    } catch (err) {
      return { configured: true, error: err.message };
    }
  });
}

systemRouter.get('/', ah(async (req, res) => {
  const db = await cached('system:db', 60 * 1000, async () => {
    const [size, tables, counts, version, shotBytes] = await Promise.all([
      query('SELECT pg_database_size(current_database()) AS bytes, current_database() AS name'),
      query(`SELECT relname AS name, pg_total_relation_size(relid) AS total_bytes,
                    pg_relation_size(relid) AS table_bytes, n_live_tup AS est_rows
             FROM pg_stat_user_tables WHERE schemaname = 'public' ORDER BY pg_total_relation_size(relid) DESC`),
      query(`SELECT (SELECT count(*) FROM screenshots) AS screenshots,
                    (SELECT min(day) FROM activity_device) AS oldest_activity,
                    (SELECT min(taken_at) FROM screenshots) AS oldest_screenshot`),
      query('SHOW server_version'),
      query('SELECT COALESCE(SUM(bytes),0) AS bytes FROM screenshots'),
    ]);
    return {
      name: size.rows[0].name,
      sizeBytes: size.rows[0].bytes,
      limitBytes: config.dbStorageLimitMb * 1024 * 1024,
      serverVersion: version.rows[0].server_version,
      tables: tables.rows,
      ...counts.rows[0],
      screenshotBytes: shotBytes.rows[0].bytes,
    };
  });

  const uptimeMs = Date.now() - dbStats.startedAt;
  res.json({
    db,
    neon: await neonInfo(),
    compute: {
      queries: dbStats.queries,
      wakeups: dbStats.wakeups,
      awakeNow: !!dbProbablyAwake(),
      lastQueryAt: dbStats.lastQueryAt ? new Date(dbStats.lastQueryAt).toISOString() : null,
      estAwakeHours: dbStats.activeMs / 3600000,
      uptimeHours: uptimeMs / 3600000,
      dutyCycle: uptimeMs ? Math.min(1, dbStats.activeMs / uptimeMs) : 0,
      wakeHistory: dbStats.wakeHistory.slice(-50).map((t) => new Date(t).toISOString()),
      poolMax: config.pgPoolMax,
      idleTimeoutMs: config.pgIdleTimeoutMs,
    },
    buffer: { ...bufferStats(), flushIntervalMin: config.flushIntervalMin, flushMaxRows: config.flushMaxRows },
    storage: {
      driver: storageDriver,
      bucket: config.s3.bucket || null,
      localBytes: storageDriver === 'local' ? await cached('system:local', 5 * 60 * 1000, localUsageBytes) : null,
    },
    fleet: {
      devices: state.devices.size,
      online: [...state.presence.values()].filter((p) => Date.now() - p.lastSeen < 6 * 60 * 1000).length,
    },
    maintenance: state.settings.maintenance || {},
    retention: state.settings.retention,
    server: { node: process.version, uptimeHours: process.uptime() / 3600, memoryMb: process.memoryUsage().rss / 1048576 },
  });
}));

systemRouter.post('/flush', requireWrite, ah(async (req, res) => {
  const rows = await flush('manual');
  res.json({ ok: true, rows });
}));

systemRouter.post('/cleanup', requireWrite, ah(async (req, res) => {
  const result = await runCleanup({ force: true });
  await audit(req, 'maintenance.cleanup', result || {});
  res.json({ ok: true, result });
}));

systemRouter.post('/vacuum', requireWrite, ah(async (req, res) => {
  // Reclaims space inside tables after large deletes (does not shrink below Neon's logical size much).
  for (const t of ['activity_app', 'activity_device', 'screenshots', 'audit_log']) await query(`VACUUM (ANALYZE) ${t}`);
  await audit(req, 'maintenance.vacuum', {});
  res.json({ ok: true });
}));
