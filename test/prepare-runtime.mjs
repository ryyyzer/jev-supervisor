#!/usr/bin/env node
/**
 * Prepare the module-resolution fixture the integration tests load.
 *
 * The integration half runs against the **real** Harness packages, so it needs a
 * `node_modules` that resolves them. This script links them from two explicit
 * locations instead of depending on anything private to one machine:
 *
 *   DSH_TEST_RUNTIME   the extracted `node_modules` of an installed Harness
 *                      (contains `@deepseek-ai/*`)
 *   DSH_TEST_PROFILE   a real profile's `node_modules` (carries the third-party
 *                      packages the runtime expects to find outside its own tree,
 *                      such as `zod`)
 *
 * It writes `test/runtime/node_modules` and a `node_modules` symlink at the repo
 * root, both ignored by Git. Nothing is installed and nothing existing is
 * modified: every entry is a symlink.
 *
 * Usage:
 *   DSH_TEST_RUNTIME=/path/to/dsh/node_modules \
 *   DSH_TEST_PROFILE=~/.dsh/profiles/desktop/node_modules \
 *   node test/prepare-runtime.mjs
 */
import { lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const fixture = join(here, 'runtime', 'node_modules');

/** Expand a leading `~` and resolve to an absolute path. */
function expand(value) {
  if (typeof value !== 'string' || value === '') return undefined;
  const expanded = value === '~' || value.startsWith('~/') ? join(homedir(), value.slice(1)) : value;
  return resolve(expanded);
}

const runtime = expand(process.env.DSH_TEST_RUNTIME ?? process.argv[2]) ?? join(repoRoot, 'work', 'installed', 'dsh', 'node_modules');
const profile = expand(process.env.DSH_TEST_PROFILE ?? process.argv[3]) ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules');

/** Remove one entry, whether it is a symlink, a file or a directory. */
function unlink(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || stat.isFile()) rmSync(path, { force: true });
    else rmSync(path, { recursive: true, force: true });
  } catch {
    /* absent */
  }
}

/** Link one directory entry, replacing an existing entry. */
function link(target, path) {
  unlink(path);
  symlinkSync(target, path, 'dir');
}

/** Entry names of a directory, or an empty list when it is absent. */
function names(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

if (names(runtime).length === 0) {
  console.error(`prepare-runtime: no packages under ${runtime}`);
  console.error('Set DSH_TEST_RUNTIME to an installed Harness node_modules directory.');
  process.exit(1);
}

rmSync(join(here, 'runtime'), { recursive: true, force: true });
mkdirSync(join(fixture, '@deepseek-ai'), { recursive: true });

let linked = 0;
// 1. Every Harness package the installed runtime ships.
for (const name of names(join(runtime, '@deepseek-ai'))) {
  link(join(runtime, '@deepseek-ai', name), join(fixture, '@deepseek-ai', name));
  linked += 1;
}
// 2. Third-party packages from a real profile (the runtime tree does not hoist
//    them; a profile does). Profile copies win, because that is what the plugin
//    resolves at runtime.
const scopes = new Set();
for (const name of names(profile)) {
  if (name.startsWith('@')) {
    for (const inner of names(join(profile, name))) {
      mkdirSync(join(fixture, name), { recursive: true });
      link(join(profile, name, inner), join(fixture, name, inner));
      linked += 1;
    }
    scopes.add(name);
  } else if (names(join(profile, name)).length > 0) {
    link(join(profile, name), join(fixture, name));
    linked += 1;
  }
}

// 3. A root `node_modules` that exposes the fixture, so `import ... from 'zod'`
//    inside lib/ resolves without the plugin installing anything.
const rootModules = join(repoRoot, 'node_modules');
rmSync(rootModules, { recursive: true, force: true });
mkdirSync(join(rootModules, '@deepseek-ai'), { recursive: true });
for (const name of names(join(fixture, '@deepseek-ai'))) {
  link(join(fixture, '@deepseek-ai', name), join(rootModules, '@deepseek-ai', name));
}
for (const name of names(fixture)) {
  if (name.startsWith('@')) continue;
  link(join(fixture, name), join(rootModules, name));
}
for (const scope of scopes) link(join(fixture, scope), join(rootModules, scope));

console.log(`prepare-runtime: linked ${linked} packages`);
console.log(`  runtime: ${runtime}`);
console.log(`  profile: ${profile}`);
console.log(`  fixture: ${fixture}`);
