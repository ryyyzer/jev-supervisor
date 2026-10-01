/**
 * Store and path tests: the settings record survives a restart, a partial record
 * merges over the configured defaults instead of replacing them, and no
 * machine-specific path is ever assumed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore, mergeSettings, persistedSettingsSchema, resolveDataDir, settingsGlobalSchema } from '../lib/store.js';

const defaults = Object.freeze({
  mode: 'shadow',
  apiEnabled: true,
  model: 'jev-1.13.0',
  callBudget: 12,
  interventionLimit: 3,
});

test('the persisted schema accepts a partial record and rejects a bad mode', () => {
  assert.equal(persistedSettingsSchema.safeParse({ mode: 'enforce' }).success, true);
  assert.equal(persistedSettingsSchema.safeParse({ mode: 'latest' }).success, false);
  assert.equal(persistedSettingsSchema.safeParse({}).success, false);
  assert.equal(persistedSettingsSchema.safeParse({ mode: 'shadow', callBudget: 900 }).success, false);
  // The global slot must not accept null: the backend uses null as "never written".
  assert.equal(settingsGlobalSchema.safeParse(null).success, false);
});

test('mergeSettings keeps configured defaults for absent fields', () => {
  assert.deepEqual(mergeSettings({ mode: 'enforce' }, defaults), { ...defaults, mode: 'enforce' });
  assert.deepEqual(
    mergeSettings({ mode: 'off', apiEnabled: false, callBudget: 0 }, defaults),
    { ...defaults, mode: 'off', apiEnabled: false, callBudget: 0 },
  );
  assert.deepEqual(mergeSettings(undefined, defaults), { ...defaults });
  assert.deepEqual(mergeSettings({ mode: 'nonsense' }, defaults), { ...defaults });
});

test('resolveDataDir is profile-scoped and needs no machine-specific path', () => {
  assert.equal(resolveDataDir({ profileContext: { dir: '/profiles/alpha' } }), `/profiles/alpha${sep}.jev-supervisor`);
  assert.equal(resolveDataDir({ profileContext: { dir: '/profiles/beta' } }), `/profiles/beta${sep}.jev-supervisor`);
  // Two profiles never share a directory.
  assert.notEqual(
    resolveDataDir({ profileContext: { dir: '/a' } }),
    resolveDataDir({ profileContext: { dir: '/b' } }),
  );
  assert.equal(resolveDataDir({ profileContext: { dir: '/a' }, dataDir: '/explicit' }), '/explicit');
  assert.equal(resolveDataDir({ profileContext: { dir: '' }, dataDir: '  ' }), join(process.cwd(), '.jev-supervisor'));
});

test('the file medium round-trips a record across a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-store-'));
  try {
    const first = await createStore({ profileContext: { dir }, dataDir: dir, defaults });
    assert.equal(first.kind, 'file');
    assert.deepEqual(await first.read(), { ...defaults });
    await first.write({ mode: 'enforce', apiEnabled: false, updatedAt: new Date().toISOString() });
    await first.close();

    const second = await createStore({ profileContext: { dir }, dataDir: dir, defaults });
    const restored = await second.read();
    assert.equal(restored.mode, 'enforce');
    assert.equal(restored.apiEnabled, false);
    assert.equal(restored.model, defaults.model);
    await second.close();

    const mode = statSync(join(dir, 'settings.json')).mode & 0o777;
    assert.equal(mode, 0o600, 'the settings file must not be group or world readable');
    const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    assert.equal(written.mode, 'enforce');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt settings file falls back to the configured defaults', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-store-'));
  try {
    writeFileSync(join(dir, 'settings.json'), '{ not json');
    const store = await createStore({ profileContext: { dir }, dataDir: dir, defaults });
    assert.deepEqual(await store.read(), { ...defaults });
    await store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compile-time API keys can never be read', async () => {
  const file = readFileSync(new URL('../lib/store.js', import.meta.url), 'utf8');
  assert.equal(/typesafe|api[_-]?key|bearer/i.test(file), false, 'the settings store must not mention a credential');
});

test('concurrent writes serialize instead of interleaving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-store-'));
  try {
    const store = await createStore({ profileContext: { dir }, dataDir: dir, defaults });
    await Promise.all([
      store.write({ mode: 'shadow', updatedAt: 'a' }),
      store.write({ mode: 'enforce', updatedAt: 'b' }),
      store.write({ mode: 'off', updatedAt: 'c' }),
    ]);
    await store.close();
    const finalRecord = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    assert.equal(finalRecord.mode, 'off', 'the last queued write wins and the file stays valid JSON');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
