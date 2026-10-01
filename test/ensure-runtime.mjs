#!/usr/bin/env node
/**
 * Make sure the module-resolution fixture exists before the suite runs.
 *
 * Silent when the fixture is already prepared, so a normal `npm test` does not
 * touch the filesystem. When it is missing, this runs `prepare-runtime.mjs` with
 * the same environment variables that script documents.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const prepared = join(here, 'runtime', 'node_modules', '@deepseek-ai', 'dsh-tools');
if (existsSync(prepared)) process.exit(0);

const result = spawnSync(process.execPath, [join(here, 'prepare-runtime.mjs')], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
