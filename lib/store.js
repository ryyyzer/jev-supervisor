/**
 * Jev Supervisor — durable, profile-scoped store for the supervision mode.
 *
 * Preferred medium: the Harness storage domain data form (`ctx.storageDomain`
 * over the mounted backend) — the official facility for host-side state that
 * must survive restarts without becoming a session event. Where that service or
 * its package is absent, the same record is kept in one JSON file inside the
 * profile directory. The fallback exists so an unusual composition degrades
 * instead of deactivating the plugin; it is not the expected path in Desktop.
 *
 * Either way the data lands under the profile the plugin was installed into.
 * No path, profile name, or user name of any particular machine is assumed: the
 * only source of location is `ctx.profileContext`, plus an optional explicit
 * override for advanced deployments.
 *
 * The store never holds a secret. Only the supervision mode and the budgets the
 * user changed are persisted.
 *
 * @module dsh-plugin-jev-supervisor/store
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/** Domain and table names must match the storage layer's unit-name grammar. */
const DOMAIN_NAME = 'jev_supervisor';
const TABLE_NAME = 'settings';
const SETTINGS_KEY = 'current';

/**
 * One persisted settings record. `mode` is required; the rest are optional so
 * that a record written by an earlier or later version of this plugin still
 * parses, and so that "unset" always means "use the configured default".
 */
export const persistedSettingsSchema = z.object({
  mode: z.enum(['off', 'shadow', 'enforce']),
  apiEnabled: z.boolean().optional(),
  model: z.string().optional(),
  callBudget: z.number().int().min(0).max(100).optional(),
  interventionLimit: z.number().int().min(0).max(10).optional(),
  /** Whether the first-run setup was completed or explicitly deferred. */
  onboarded: z.boolean().optional(),
  updatedAt: z.string().optional(),
});

/** Global slot of the domain: which record is current, and its revision. */
export const settingsGlobalSchema = z.object({
  current: z.string(),
  revision: z.number().int().min(0),
});

/** Serialize access to one file target so concurrent writers cannot interleave. */
const fileChains = new Map();
const onChain = (path, work) => {
  const previous = fileChains.get(path) ?? Promise.resolve();
  const next = previous.then(work, work);
  fileChains.set(
    path,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
};

/**
 * Merge a stored record over the configured defaults.
 *
 * Only fields actually present in the stored record win, and only when they are
 * valid; everything else keeps the default from `cordis.patch.yml`. This is what
 * lets a user edit the patch layer without the plugin's stored mode fighting it
 * over unrelated values.
 *
 * @param stored - candidate persisted record.
 * @param defaults - effective defaults from the plugin row.
 * @returns a complete settings record.
 */
export function mergeSettings(stored, defaults) {
  const parsed = persistedSettingsSchema.safeParse(stored);
  if (!parsed.success) return { ...defaults };
  const record = parsed.data;
  return {
    ...defaults,
    mode: record.mode,
    ...(record.apiEnabled === undefined ? {} : { apiEnabled: record.apiEnabled }),
    ...(record.model === undefined ? {} : { model: record.model }),
    ...(record.callBudget === undefined ? {} : { callBudget: record.callBudget }),
    ...(record.interventionLimit === undefined ? {} : { interventionLimit: record.interventionLimit }),
    ...(record.onboarded === undefined ? {} : { onboarded: record.onboarded }),
  };
}

/**
 * File-backed settings medium inside one directory.
 * @param dir - directory that owns the settings file.
 * @param defaults - effective defaults.
 * @returns the store interface.
 */
function fileStore(dir, defaults) {
  const path = join(dir, 'settings.json');
  return {
    kind: 'file',
    async read() {
      let stored;
      try {
        stored = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return { ...defaults };
      }
      return mergeSettings(stored, defaults);
    },
    async write(record) {
      await onChain(path, async () => {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const temp = `${path}.tmp`;
        writeFileSync(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
        renameSync(temp, path);
      });
    },
    async close() {},
  };
}

/**
 * Storage-domain-backed settings medium.
 * @param domain - open domain handle from `ctx.storageDomain.open`.
 * @param defaults - effective defaults.
 * @returns the store interface.
 */
function domainStore(domain, defaults) {
  const table = domain.table(TABLE_NAME);
  const global = domain.global;
  return {
    kind: 'storage-domain',
    async read() {
      return mergeSettings(table.get(SETTINGS_KEY), defaults);
    },
    async write(record) {
      if (table.get(SETTINGS_KEY) === undefined) await table.put(SETTINGS_KEY, record);
      else await table.update(SETTINGS_KEY, () => record);
      await global.set({ current: SETTINGS_KEY, revision: (global.get()?.revision ?? 0) + 1 });
    },
    async close() {
      await domain.close();
    },
  };
}

/**
 * Open the settings store for one profile.
 *
 * The storage domain is preferred and loaded lazily. A deployment that does not
 * mount the service, does not ship the package, or fails to open the domain
 * silently falls back to the profile-local file instead of deactivating the
 * plugin. Individual read and write failures fall back the same way, so a
 * storage fault can never break the user's original task.
 *
 * @param options - `storageDomain` service (when mounted), the owning profile
 *   context, effective defaults, and an optional explicit data directory.
 * @returns a promise of the store interface: `read`, `write`, `close`, `kind`.
 */
export async function createStore({ storageDomain, profileContext, dataDir, defaults = {} } = {}) {
  const directory = resolveDataDir({ profileContext, dataDir });
  const file = fileStore(directory, defaults);
  if (storageDomain && typeof storageDomain.open === 'function') {
    try {
      const { defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain');
      const domain = await storageDomain.open(
        defineDomain({
          name: DOMAIN_NAME,
          version: 1,
          global: { schema: settingsGlobalSchema, initial: { current: SETTINGS_KEY, revision: 0 } },
          tables: { [TABLE_NAME]: domainTable(persistedSettingsSchema) },
        }),
      );
      const store = domainStore(domain, defaults);
      return {
        kind: store.kind,
        async read() {
          try {
            return await store.read();
          } catch {
            return file.read();
          }
        },
        async write(record) {
          try {
            await store.write(record);
          } catch {
            await file.write(record);
          }
        },
        async close() {
          try {
            await store.close();
          } catch {
            /* already closed or never opened */
          }
        },
      };
    } catch {
      // Service present but the domain could not open (route, schema or
      // version failure): keep going on the profile-local file.
    }
  }
  return file;
}

/**
 * Resolve the directory this plugin owns inside one profile.
 *
 * Profile-scoped by construction: the same plugin installed into two profiles
 * keeps two independent directories, and a profile moved on disk keeps its data
 * beside its own composition files.
 *
 * @param options - profile context and an optional explicit override.
 * @returns absolute data directory path.
 */
export function resolveDataDir({ profileContext, dataDir } = {}) {
  if (typeof dataDir === 'string' && dataDir.trim() !== '') return resolve(dataDir.trim());
  const dir = profileContext?.dir;
  if (typeof dir === 'string' && dir.trim() !== '') return join(resolve(dir), '.jev-supervisor');
  // No profile at all (a bare `dsh` process): a process-local fallback keeps the
  // plugin functional instead of guessing at a machine-specific path.
  return join(process.cwd(), '.jev-supervisor');
}
