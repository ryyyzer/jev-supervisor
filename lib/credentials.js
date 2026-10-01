/**
 * Jev Supervisor — credential access through the official seam.
 *
 * The TypeSafe key is addressed by reference name only. The value is obtained
 * from `ctx.credentials` — the Harness credential seam, which resolves from the
 * provider the deployment mounts and never appears in configuration, in a
 * session event, in a model request, in a log line, or on a command line.
 *
 * ## Profile-scoped reference
 *
 * The mounted local provider keeps ONE document (`$DSH_HOME/.credentials.yaml`)
 * for the whole harness home, so a fixed reference name would be a single
 * shared slot: two profiles would read and overwrite each other's key. The
 * reference is therefore derived from the owning profile — the reference *name*
 * carries the isolation, because that is the only per-profile dimension the
 * credential seam exposes.
 *
 * Consequences, stated plainly:
 * - Profiles in the same harness home never read or overwrite each other's entry.
 * - The file itself remains one owner-only document shared inside that home; a
 *   process running as the same OS user can still read every entry in it. This
 *   plugin neither claims nor provides OS keychain storage.
 * - The derived name is unique per profile directory, so moving a profile moves
 *   its credential slot with it (the value must be entered again).
 *
 * @module dsh-plugin-jev-supervisor/credentials
 */
import { createHash } from 'node:crypto';

/**
 * Reference base name. A POSIX shell identifier, which is what the credential
 * seam's reference grammar requires, and deliberately namespaced so it cannot
 * collide with a provider key such as `DEEPSEEK_API_KEY`.
 */
export const KEY_REF_BASE = 'JEV_TYPESAFE_API_KEY';

/** Suffix length of the profile digest embedded in a derived reference name. */
const DIGEST_LENGTH = 10;

/**
 * Derive the credential reference name this installation owns.
 *
 * Deterministic for one profile and different across profiles, without leaking
 * the profile path into the name.
 *
 * @param options - the owning profile context and an optional explicit name.
 * @returns the reference name to use for every credential operation.
 */
export function resolveKeyRef({ profileContext, keyRef } = {}) {
  if (typeof keyRef === 'string' && keyRef.trim() !== '') return keyRef.trim();
  const identity = typeof profileContext?.dir === 'string' && profileContext.dir !== '' ? profileContext.dir : (profileContext?.name ?? '');
  if (identity === '') return KEY_REF_BASE;
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, DIGEST_LENGTH).toUpperCase();
  return `${KEY_REF_BASE}_${digest}`;
}

/** Credential seam methods this module needs; all are on the public service. */
const REQUIRED = ['resolve', 'describe'];

/**
 * Whether the mounted credential service exposes the read surface this plugin
 * requires. A deployment without a credential provider leaves the plugin
 * usable in `off`/`shadow` and simply unable to make API calls.
 * @param credentials - candidate `ctx.credentials` value.
 * @returns true when the read surface is present.
 */
export function isCredentialService(credentials) {
  return !!credentials && REQUIRED.every(method => typeof credentials[method] === 'function');
}

/**
 * Live view of one credential reference through the seam.
 *
 * The reader holds no copy of the secret. Every read asks the provider, so a key
 * the user replaces or removes reaches the very next supervision call without a
 * plugin restart, and nothing here has to be invalidated on clear, on API
 * shutdown, or on unload.
 *
 * @param credentials - `ctx.credentials`; when absent, every read reports
 *   "not configured" instead of throwing, so the plugin degrades to a reported
 *   `not_configured` state rather than breaking the user's original flow.
 * @param keyRef - the profile-scoped reference name this installation owns.
 * @returns a reader with `ref`, `resolveRef`, `describeRef` and `resolve`.
 */
export function createCredentialReader(credentials, keyRef = KEY_REF_BASE) {
  const service = isCredentialService(credentials) ? credentials : undefined;

  return {
    /** Whether a credential provider is mounted at all. */
    available: service !== undefined,

    /** The exact reference name every operation on this installation uses. */
    ref: keyRef,

    /** Whether the key is stored, its source, and whether it can be replaced. */
    async describeRef() {
      if (!service) return { configured: false, writable: false };
      try {
        const info = await service.describe(keyRef);
        return { configured: info?.configured === true, source: info?.source, writable: info?.writable === true };
      } catch {
        return { configured: false, writable: false };
      }
    },

    /**
     * Resolve the live key value for one operation. Called once per
     * supervision call; the value is used and released, never retained here.
     * @returns the key, or undefined when it is not configured.
     */
    async resolveRef() {
      if (!service) return undefined;
      try {
        const hit = await service.resolve(keyRef);
        const value = typeof hit?.value === 'string' ? hit.value.trim() : '';
        return value === '' ? undefined : value;
      } catch {
        // A read-only source shadowing the reference, or a provider fault,
        // reads as "unavailable" rather than as an error the user must handle.
        return undefined;
      }
    },
  };
}
