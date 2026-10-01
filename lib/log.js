/**
 * Jev Supervisor — local, bounded, redacted audit log.
 *
 * The log is deliberately separate from everything the model can see: it is a
 * plain JSONL file inside the profile the plugin was installed into, never a
 * session event, never a model request, and never a tool result. It records
 * supervision identity, the decision, the action, the model and usage the API
 * reported, and the latency — with every string scrubbed and every live secret
 * removed verbatim.
 *
 * A logging failure must never break the user's original task, so every write is
 * contained.
 *
 * @module dsh-plugin-jev-supervisor/log
 */
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scrub } from './core.js';

/** Rotate at 5 MiB, keeping one previous file. */
const MAX_BYTES = 5 * 1024 * 1024;
/** Maximum records retained in memory for the details view. */
const MAX_TAIL = 40;

/**
 * Create the audit logger for one data directory.
 *
 * @param options - `dir`, and a `secrets` provider whose live value is removed
 *   from every record before it is written.
 * @returns a logger with `record`, `tail` and `path`.
 */
export function createLog({ dir, secrets = () => [] } = {}) {
  const path = join(dir, 'supervisor.jsonl');
  const previous = join(dir, 'supervisor.previous.jsonl');
  const tail = [];

  const rotate = () => {
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, previous);
    } catch {
      /* Rotation is best effort; bound the file on the next call. */
    }
  };

  return {
    path,

    /**
     * Append one record. The record is scrubbed structurally and against the
     * live secret, so no key can reach the file even if a caller passed one in.
     * @param record - fields to record.
     * @param mode - the live supervision mode.
     */
    record(record, mode) {
      const live = typeof secrets === 'function' ? secrets() : secrets;
      const entry = scrub({ time: new Date().toISOString(), mode, ...record }, 0, live);
      tail.push(entry);
      if (tail.length > MAX_TAIL) tail.shift();
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        rotate();
        appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        // appendFileSync's mode applies only at creation; enforce on every write.
        chmodSync(path, 0o600);
      } catch {
        /* Logging failure cannot break the original flow. */
      }
    },

    /** Recent records, newest last, for the details view. */
    tail() {
      return [...tail];
    },
  };
}
