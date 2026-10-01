/**
 * Jev Supervisor — host half.
 *
 * An external, standalone DeepSeek Harness bundle. It supervises tool calls an
 * agent is about to make (or has just made) by asking the TypeSafe system API
 * with a bounded, redacted state snapshot, and — when the user has explicitly
 * enabled enforcement — can deny a call, ask the user, or add corrective context
 * for the next step.
 *
 * Boundaries this plugin keeps:
 * - No DeepSeek summarization call is added; the model route is untouched.
 * - Stop-continuation is never forced: a required user decision ends the blocked
 *   turn, and no automatic re-plan is started.
 * - The original approval gate always wins; supervision only ever narrows.
 * - The TypeSafe key is read through `ctx.credentials` and never reaches
 *   configuration, a session event, a model request, a log line, or a tool result.
 * - Supervision state lives in the profile the plugin was installed into; no
 *   machine-specific path, profile name, or keychain item is assumed.
 *
 * @module dsh-plugin-jev-supervisor
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Schema from '@deepseek-ai/schemastery';
import { z } from 'zod';
import {
  CALL_BUDGET_MAX,
  CALL_BUDGET_MIN,
  DEFAULTS,
  INTERVENTION_LIMIT_MAX,
  INTERVENTION_LIMIT_MIN,
  MODES,
  MODEL_RE,
  Supervisor,
  callJev,
  classifySupervision,
  fold,
  initialProjection,
  makeSnapshot,
  scrub,
} from './core.js';
import { createCredentialReader, resolveKeyRef } from './credentials.js';
import { createStore, resolveDataDir } from './store.js';
import { createLog } from './log.js';
import { attachAgent } from './adapter.js';

export const name = 'jev-supervisor';

/**
 * Services required before activation.
 *
 * `credentials` is a hard dependency on purpose: the credential provider mounts
 * its service only after its own asynchronous init, so reading it opportunistically
 * during activation races it and can observe "absent" on a perfectly normal
 * deployment. Declaring it here makes cordis activate this plugin once the
 * service exists, which is the supported way to depend on a service that is not
 * ready at boot. `storageDomain` and `connection` stay optional, because they
 * only affect where settings live and which surfaces are reachable.
 */
export const inject = ['tools', 'agents', 'sessionProjections', 'commands', 'credentials'];

/** Session projection key: the bounded evidence cache each judgment reads. */
export const PROJECTION_KEY = 'jev-supervisor.evidence.v1';

/** HTTP namespace the Client half calls for user-gesture operations. */
const ROUTE_PREFIX = '/api/jev-supervisor';

/** How often the reachability probe runs while no key has been seen. */
const PROBE_INTERVAL_MS = 20_000;

/**
 * Plugin configuration. Every value here has a working default, so the bundle
 * patch can insert the row with only the values a deployment wants to change.
 */
export const Config = Schema.object({
  mode: Schema.union(MODES.map(value => Schema.const(value))).default(DEFAULTS.mode),
  apiEnabled: Schema.boolean().default(true),
  model: Schema.string()
    .pattern(MODEL_RE)
    .default(DEFAULTS.model),
  timeoutMs: Schema.number().step(1).min(500).max(15000).default(DEFAULTS.timeoutMs),
  callBudget: Schema.number()
    .step(1)
    .min(CALL_BUDGET_MIN)
    .max(CALL_BUDGET_MAX)
    .default(DEFAULTS.callBudget),
  interventionLimit: Schema.number()
    .step(1)
    .min(INTERVENTION_LIMIT_MIN)
    .max(INTERVENTION_LIMIT_MAX)
    .default(DEFAULTS.interventionLimit),
  confidenceThreshold: Schema.number().min(0.8).max(1).default(DEFAULTS.confidenceThreshold),
  probabilityThreshold: Schema.number().min(0.8).max(1).default(DEFAULTS.probabilityThreshold),
  snapshotBytes: Schema.number().step(1).min(2000).max(16000).default(DEFAULTS.snapshotBytes),
  /**
   * Explicit credential reference name. Empty (the default) derives a
   * profile-scoped name, which is what keeps two profiles in one harness home
   * from reading or overwriting each other's key. Set it only to pin a name a
   * deployment already manages.
   */
  keyRef: Schema.string().default(''),
  dataDir: Schema.string().default(''),
});

/** Stable envelope for every route answer. */
const answer = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/**
 * The message-source kind this plugin owns.
 *
 * The installed session format is V4, whose admission requires a **producer-owned
 * source kind** and explicitly refuses the retired V3 wrapper `kind: 'plugin'`
 * (`format v4 message requires a producer-owned source kind`). A producer-owned
 * kind is the producer's own identity — the plugin's **package name** prefixed
 * with `plugin:` — and it is not a role: it keeps supervision's own words
 * distinct from a real user instruction without pretending to be one.
 *
 * The package name is deliberate rather than the loader row name (`name`, which
 * the bundle patch's `id`/`name` pair sets to the shorter `jev-supervisor`): the
 * producer identity a reader sees in a persisted row should name the thing that
 * produced it, and the package name is the name this plugin is installed under.
 */
export const PACKAGE_NAME = 'dsh-plugin-jev-supervisor';
export const PRODUCER_KIND = `plugin:${PACKAGE_NAME}`;

/**
 * Build one corrective-context message.
 *
 * `source.kind` is the producer-owned kind above, never `user`: the evidence
 * projection treats only `source.kind === 'user'` as user authority, so
 * supervision's own wording can never be mistaken for an instruction the user
 * gave. The message is still a user-role model turn, which is what carries
 * context into the next admitted step.
 *
 * The source carries only the kind. That is the shape the format's own producer
 * mapping emits, so a persisted row round-trips through admission unchanged.
 *
 * @param text - feedback text.
 * @returns an immutable identified message.
 */
function createFeedbackMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    source: { kind: PRODUCER_KIND },
    content: [{ type: 'text', text }],
  });
}

/** Deep-freeze a structured copy without depending on a Harness package. */
function deepFreeze(value) {
  const clone = structuredClone(value);
  const walk = node => {
    if (node && typeof node === 'object') {
      Object.freeze(node);
      for (const child of Object.values(node)) walk(child);
    }
    return node;
  };
  return walk(clone);
}

/** Read a bounded JSON body; `undefined` means "malformed or too large". */
async function readJson(request, limit = 8 * 1024) {
  try {
    const text = await request.text();
    if (text.length > limit) return undefined;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a request URL without throwing on a malformed one. */
function url(request) {
  try {
    return new URL(request.url);
  } catch {
    return new URL('http://127.0.0.1/');
  }
}

/**
 * Plugin body.
 * @param ctx - host context.
 * @param config - validated configuration for this row.
 */
export function apply(ctx, config) {
  const profile = ctx.profileContext;
  const dataDir = resolveDataDir({ profileContext: profile, dataDir: config.dataDir });
  /** The profile-scoped credential reference every operation on this row uses. */
  const keyRef = resolveKeyRef({ profileContext: profile, keyRef: config.keyRef });

  /** Effective runtime settings: row defaults, overridden by the stored record. */
  const live = {
    mode: config.mode,
    apiEnabled: config.apiEnabled,
    model: config.model,
    timeoutMs: config.timeoutMs,
    callBudget: config.callBudget,
    interventionLimit: config.interventionLimit,
    confidenceThreshold: config.confidenceThreshold,
    probabilityThreshold: config.probabilityThreshold,
    snapshotBytes: config.snapshotBytes,
    onboarded: false,
  };

  /**
   * The mounted credential seam, read on every use.
   *
   * Resolving it per call instead of once is what makes a late or replacement
   * provider visible: a service that arrives after activation, or an HMR swap of
   * the provider, is picked up on the next read rather than being remembered as
   * absent for the lifetime of the plugin.
   */
  const credentialService = () => ctx.get('credentials');
  const credentialReader = () => createCredentialReader(credentialService(), keyRef);

  /**
   * The key value for the ONE call currently in flight, or `undefined`.
   *
   * It exists only so the log scrubber can remove the live value from the record
   * written while that call is in flight, and it is cleared in a `finally` as
   * soon as the call settles — clearing the credential, disabling the API,
   * unloading the plugin, or simply finishing a call all leave nothing behind.
   */
  let activeKey;

  const log = createLog({ dir: dataDir, secrets: () => (activeKey === undefined ? [] : [activeKey]) });

  const getKey = async signal => {
    activeKey = await credentialReader().resolveRef(signal);
    return activeKey;
  };

  /**
   * The outbound call, wrapped so the value it was handed is released whatever
   * the outcome: success, HTTP failure, validation failure, timeout or abort.
   * Every judgement path already routes through this one function, so the
   * lifetime of the plugin's only reference to the key is exactly one call.
   */
  const guardedCall = async options => {
    try {
      return await callJev(options);
    } finally {
      activeKey = undefined;
    }
  };

  /**
   * Fold one settled judgement into the connectivity state.
   *
   * This is the only path that may report a working connection, and it is
   * driven by real supervised calls — no probe and no refresh triggers a request.
   * A skipped judgement (off, budget, an original denial) never reaches here, so
   * it can neither prove nor damage connectivity, and a spent budget is never
   * mistaken for a network failure.
   *
   * @param event - `{ result }` from {@link Supervisor.judge}.
   */
  const onJudgementSettled = ({ result }) => {
    if (!result) return;
    if (result.judgment) {
      status.reachability = 'connected';
      status.verified = true;
      status.lastReason = null;
      status.lastCallAt = result.judgment.at ?? new Date().toISOString();
      return;
    }
    // No judgement means the call did not produce one: a transport or API fault.
    const failure = typeof result.failure === 'string' ? result.failure : result.reason;
    if (failure === 'cancelled' || failure === 'mode_changed') return;
    status.verified = false;
    if (failure === 'key_unavailable') {
      // A missing or unreadable credential is a configuration state, not a
      // network fact: keep it out of the connectivity vocabulary.
      status.reachability = 'not_configured';
      return;
    }
    status.reachability = 'unreachable';
    status.lastReason = failure ?? 'request_failed';
    status.lastCallAt = new Date().toISOString();
  };

  /** Whether the budget was chosen on this machine rather than inherited. */
  let budgetChosen = false;
  /** Whether the intervention limit was chosen on this machine. */
  let interventionChosen = false;

  const supervisor = new Supervisor(live, { getKey, call: guardedCall, onResult: onJudgementSettled });
  supervisor.config = live;

  // ---------------------------------------------------------------------------
  // Durable settings, then per-session evidence projection
  // ---------------------------------------------------------------------------
  let store;
  let storeReady = false;
  ctx.effect(() => {
    let disposed = false;
    void (async () => {
      const opened = await createStore({ storageDomain: ctx.get('storageDomain'), profileContext: profile, dataDir: config.dataDir, defaults: live });
      if (disposed) {
        await opened.close().catch(() => {});
        return;
      }
      store = opened;
      const saved = await store.read().catch(() => undefined);
      if (disposed || !saved) return;
      live.mode = saved.mode;
      if (typeof saved.apiEnabled === 'boolean') live.apiEnabled = saved.apiEnabled;
      if (typeof saved.onboarded === 'boolean') live.onboarded = saved.onboarded;
      // A stored budget is a deliberate value, so it survives future default
      // changes; an absent one keeps following the row.
      if (typeof saved.callBudget === 'number') {
        live.callBudget = saved.callBudget;
        budgetChosen = true;
      }
      if (typeof saved.interventionLimit === 'number') {
        live.interventionLimit = saved.interventionLimit;
        interventionChosen = true;
      }
      storeReady = true;
      log.record(
        { kind: 'settings-loaded', store: store.kind, mode: live.mode, apiEnabled: live.apiEnabled, keyRef, onboarded: live.onboarded },
        live.mode,
      );
    })();
    return () => {
      disposed = true;
      void store?.close().catch(() => {});
      store = undefined;
    };
  });

  /**
   * Persist the settings this installation owns.
   *
   * A value the user never changed is omitted, so an upgrade can move a default
   * (the call budget went from 12 to 24) without being overwritten by a stored
   * copy of the previous default. `budgetChosen` tracks whether the budget was
   * actually chosen here rather than merely read from the row.
   */
  const persist = () => {
    if (!store || !storeReady) return;
    void store
      .write({
        mode: live.mode,
        apiEnabled: live.apiEnabled,
        model: live.model,
        ...(budgetChosen ? { callBudget: live.callBudget } : {}),
        ...(interventionChosen ? { interventionLimit: live.interventionLimit } : {}),
        onboarded: live.onboarded,
        updatedAt: new Date().toISOString(),
      })
      .catch(() => {});
  };

  ctx.effect(() =>
    ctx.sessionProjections.register({
      key: PROJECTION_KEY,
      stateVersion: 1,
      stateSchema: z.any(),
      init: initialProjection,
      apply: fold,
    }),
  );
  const readProjection = agent => ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY);

  // ---------------------------------------------------------------------------
  // Reachability state, for the status surfaces
  // ---------------------------------------------------------------------------
  const status = {
    /** `unknown` until a real call settles; `connected` only after one did. */
    reachability: 'unknown',
    /** Last fault reason, redacted, for the details view. */
    lastReason: null,
    lastCallAt: null,
    /** Whether a successful verification has been observed in this process. */
    verified: false,
  };

  /**
   * Refresh credential presence without ever claiming reachability.
   *
   * A stored key proves only that a key is stored. `connected` is set by an
   * actual API round trip — the connection check or a supervised call — so the
   * UI cannot report a working connection that was never exercised.
   */
  const probe = async () => {
    const info = await credentialReader().describeRef();
    if (!info.configured) {
      status.reachability = 'not_configured';
      status.verified = false;
      return status;
    }
    if (status.reachability === 'not_configured' || status.reachability === 'unknown') {
      status.reachability = status.verified ? 'connected' : 'unverified';
    }
    return status;
  };

  ctx.effect(() => {
    // A changed stored key must reach the UI without a restart, and it also
    // invalidates the previous verification: a different key is a different fact.
    const refresh = () => {
      const identity = status.keyIdentity;
      void credentialReader().describeRef().then(info => {
        const nextIdentity = `${info.configured}:${info.source ?? ''}`;
        if (nextIdentity !== identity) {
          status.verified = false;
          status.reachability = info.configured ? 'unverified' : 'not_configured';
        }
        status.keyIdentity = nextIdentity;
      });
    };
    const disposers = [];
    // Subscribe unconditionally: the provider may arrive after activation.
    disposers.push(ctx.on('credentials/reference-updated', refresh));
    const timer = setInterval(() => {
      if (status.reachability !== 'connected') void probe();
    }, PROBE_INTERVAL_MS);
    timer.unref?.();
    void probe();
    return () => {
      clearInterval(timer);
      for (const dispose of disposers) dispose();
    };
  });

  // ---------------------------------------------------------------------------
  // Per-agent attachment
  // ---------------------------------------------------------------------------
  const attached = new Map();
  /**
   * The session most recently seen by supervision, so a surface with no session
   * of its own (settings, first-run panel) reports the task the user is on.
   */
  let recentlySupervised = null;
  const attach = agent => {
    if (attached.has(agent.id)) return;
    attached.set(
      agent.id,
      attachAgent(ctx, agent, supervisor, {
        readProjection,
        log: record => {
          recentlySupervised = agent.id;
          log.record(record, live.mode);
        },
        save: persist,
        createContext: createFeedbackMessage,
      }),
    );
  };
  for (const agent of ctx.agents.list()) attach(agent);
  ctx.on('agent/created', ({ agent }) => attach(agent));
  ctx.on('agent/disposed', ({ agent }) => {
    attached.get(agent.id)?.();
    attached.delete(agent.id);
  });

  ctx.effect(() => () => {
    supervisor.dispose();
    for (const dispose of attached.values()) dispose();
    attached.clear();
  });

  // ---------------------------------------------------------------------------
  // Shared operations: one implementation behind the UI and the /jev command
  // ---------------------------------------------------------------------------
  const taskIdOf = agent => `${agent.id}:${readProjection(agent)?.goal?.id ?? 'session-task'}`;

  /**
   * Resolve the live agent that owns one session id.
   *
   * A status read is scoped to a session so the budget it reports is that
   * session's task, not an arbitrary one. When the caller names no session — the
   * settings page and the first-run panel have none — the most recently
   * supervised session is used, because that is the task the user is looking at.
   * An unknown id reports the plugin-wide view instead of guessing at a task.
   *
   * @param sessionId - session id from the request, or null.
   * @returns the agent, or undefined.
   */
  const agentForSession = sessionId => {
    const wanted = typeof sessionId === 'string' && sessionId !== '' ? sessionId : recentlySupervised;
    if (wanted === null) return undefined;
    return ctx.agents.list().find(agent => agent.id === wanted || agent.session?.id === wanted);
  };

  /**
   * Record the first-run setup decision. It is a durable flag only: it changes
   * no mode, no budget, and no credential.
   * @param value - true once the setup was completed or explicitly deferred.
   */
  const setOnboarded = value => {
    live.onboarded = value === true;
    persist();
    log.record({ kind: 'onboarding', action: live.onboarded ? 'dismissed' : 'reset' }, live.mode);
  };

  const setMode = value => {
    supervisor.cancelCalls();
    live.mode = value;
    persist();
    log.record({ kind: 'mode-change', action: value, sessionId: null }, live.mode);
    return { mode: live.mode };
  };

  /**
   * Change the per-task call budget and/or the independent intervention limit.
   *
   * Validation is explicit: integer, inside the declared range. Nothing else is
   * touched. In particular the task counters are deliberately left alone, so a
   * raised budget lifts the limit on the next read and supervision resumes with
   * the spend it already had — raising a budget never buys back past calls.
   *
   * @param input - `callBudget` and/or `interventionLimit` as sent by the UI.
   * @returns the applied values plus the spend of the current task.
   */
  /**
   * Parse and validate one budget request into a patch.
   *
   * Pure: it reads nothing but its argument, so a rejected request has provably
   * changed nothing by the time the caller decides what to do with it. This is
   * deliberately separate from applying the change — a validator that mutates as
   * it walks fields leaves a partially applied request behind when a later field
   * turns out to be invalid.
   *
   * @param input - candidate `callBudget` and/or `interventionLimit`.
   * @returns `{ patch, fields }`; `fields` is empty exactly when `patch` is valid.
   */
  const validateBudgetPatch = (input = {}) => {
    const patch = {};
    const fields = [];
    if (input.callBudget !== undefined) {
      const value = Number(input.callBudget);
      if (Number.isSafeInteger(value) && value >= CALL_BUDGET_MIN && value <= CALL_BUDGET_MAX) patch.callBudget = value;
      else fields.push('callBudget');
    }
    if (input.interventionLimit !== undefined) {
      const value = Number(input.interventionLimit);
      if (Number.isSafeInteger(value) && value >= INTERVENTION_LIMIT_MIN && value <= INTERVENTION_LIMIT_MAX) patch.interventionLimit = value;
      else fields.push('interventionLimit');
    }
    return { patch, fields };
  };

  const setBudget = (input = {}) => {
    const { patch, fields } = validateBudgetPatch(input);
    // Any invalid field rejects the whole request: nothing below has run, so the
    // live limits, the chosen flags, the counters, the store and the audit are
    // all exactly as they were.
    if (fields.length > 0) return { ok: false, code: 'invalid_budget', fields };
    if (Object.keys(patch).length === 0) return { ok: false, code: 'bad_request' };
    // Only now, with every provided field valid, apply the change at once.
    if (patch.callBudget !== undefined) {
      live.callBudget = patch.callBudget;
      budgetChosen = true;
    }
    if (patch.interventionLimit !== undefined) {
      live.interventionLimit = patch.interventionLimit;
      interventionChosen = true;
    }
    supervisor.configure(patch);
    persist();
    log.record(
      { kind: 'budget-change', action: 'applied', callBudget: live.callBudget, interventionLimit: live.interventionLimit, fields: Object.keys(patch).sort() },
      live.mode,
    );
    return { ok: true, callBudget: live.callBudget, interventionLimit: live.interventionLimit };
  };

  const setApiEnabled = value => {
    supervisor.cancelCalls();
    live.apiEnabled = value;
    persist();
    log.record({ kind: 'api-setting', action: value ? 'enabled' : 'disabled' }, live.mode);
    return { apiEnabled: live.apiEnabled };
  };

  /**
   * Real connectivity check: one actual API call with a fixed synthetic
   * snapshot, using the live key. Reports the model the API answered with and
   * the round-trip latency; never reports the key.
   */
  const verifyConnection = async signal => {
    const key = await getKey(signal);
    if (!key) {
      status.reachability = 'not_configured';
      status.verified = false;
      return { ok: false, code: 'key_not_configured' };
    }
    const snapshot = makeSnapshot(
      { ...initialProjection({ id: 'connection-check' }), users: [{ authority: 'user', text: 'Read a project version without modifying files.' }] },
      { callId: 'connection-check', name: 'read_version', arguments: {} },
      undefined,
      2000,
      [key],
    );
    try {
      const result = await callJev({ snapshot, model: live.model, key, signal, timeoutMs: live.timeoutMs });
      status.reachability = 'connected';
      status.verified = true;
      status.lastReason = null;
      status.lastCallAt = new Date().toISOString();
      log.record(
        {
          kind: 'connection-verified',
          action: 'ready',
          keyRef,
          model: result.model,
          decision: result.choice,
          usage: result.usage,
          latencyMs: result.latencyMs,
        },
        live.mode,
      );
      return { ok: true, model: result.model, choice: result.choice, latencyMs: result.latencyMs, usage: result.usage };
    } catch (error) {
      const code = /^(HTTP_\d+|MODEL_MISMATCH|INVALID_\w+|RESPONSE_TOO_LARGE)$/.test(error?.message)
        ? error.message
        : error?.name === 'TimeoutError'
          ? 'timeout'
          : 'request_failed';
      status.reachability = 'unreachable';
      status.verified = false;
      status.lastReason = code;
      log.record({ kind: 'connection-verify-failed', action: 'failed', keyRef, reason: code }, live.mode);
      return { ok: false, code };
    } finally {
      // The verification call is over; do not keep the value it used.
      activeKey = undefined;
    }
  };

  /**
   * The status every surface reads.
   *
   * Connection facts and supervision facts are returned separately, because the
   * UI must be able to say "connected" and "this task is no longer supervised"
   * at the same time. `supervision` is the classification the header renders;
   * `budget` is the raw accounting behind it.
   *
   * @param agent - the agent whose task is being reported; omitted for the
   *   plugin-wide view, which reports the configured limits without a task.
   */
  const statusReport = async agent => {
    const info = await credentialReader().describeRef();
    const taskId = agent ? taskIdOf(agent) : undefined;
    const budget = agent
      ? supervisor.budgetOf(taskId)
      : {
          calls: 0,
          callBudget: live.callBudget,
          interventions: 0,
          interventionLimit: live.interventionLimit,
          faults: 0,
          maxFaults: live.maxConsecutiveFaults ?? DEFAULTS.maxConsecutiveFaults,
          paused: false,
          limit: null,
          reason: null,
          judgment: null,
        };
    const reachability = info.configured ? status.reachability : 'not_configured';
    const supervision = classifySupervision({
      mode: live.mode,
      apiEnabled: live.apiEnabled,
      reachability,
      keyConfigured: info.configured,
      budget,
    });
    return {
      mode: live.mode,
      apiEnabled: live.apiEnabled,
      keyConfigured: info.configured,
      keyWritable: info.writable,
      keyRef,
      credentialProvider: credentialReader().available,
      reachability,
      supervision: supervision.state,
      supervisionReason: supervision.reason,
      lastReason: status.lastReason,
      lastCallAt: status.lastCallAt,
      model: live.model,
      taskId: taskId ?? null,
      // Without an explicit goal this accounting is per session, not per turn.
      accounting: agent ? (readProjection(agent)?.goal?.id ? 'goal' : 'session') : 'session',
      calls: budget.calls,
      callBudget: budget.callBudget,
      interventions: budget.interventions,
      interventionLimit: budget.interventionLimit,
      paused: budget.paused,
      faults: budget.faults,
      limit: budget.limit,
      // The limit's own canonical reason; the decision that preceded it is
      // reported separately so a low-confidence judgement can never be read as
      // the reason a budget-limited task stopped.
      limitReason: budget.limitReason,
      lastDecisionReason: budget.lastDecisionReason,
      // The limits actually in force and the spend they are measured against, so
      // a surface can show "9 / 24" without assuming which value is live.
      limits: { callBudget: live.callBudget, interventionLimit: live.interventionLimit },
      callsUsed: budget.calls,
      interventionsUsed: budget.interventions,
      faults: budget.faults,
      store: store?.kind ?? 'pending',
      onboarded: live.onboarded,
    };
  };

  // ---------------------------------------------------------------------------
  // Native command: /jev
  // ---------------------------------------------------------------------------
  const HELP = 'Jev: status | off | shadow | enforce | resume | reset | model <jev-x.y.z>';

  ctx.effect(() =>
    ctx.commands.register({
      name: 'jev',
      description: `Jev Supervisor — status / off / shadow / enforce / resume / reset / model. Supervision data is sent to TypeSafe.`,
      input: { hint: 'status | off | shadow | enforce | resume | reset | model jev-x.y.z' },
      handler: async ({ agent, rawInput, signal }) => {
        const [action = 'status', value] = String(rawInput ?? '').trim().split(/\s+/);
        if (MODES.includes(action)) {
          setMode(action);
        } else if (action === 'resume') {
          supervisor.task(taskIdOf(agent)).paused = false;
          persist();
        } else if (action === 'reset') {
          // Clearing the runtime task state is an explicit user action; it is
          // recorded, and it never changes a mode, a limit or a credential.
          supervisor.resetTask(taskIdOf(agent));
          persist();
          log.record({ kind: 'task-reset', action: 'cleared', taskId: taskIdOf(agent), sessionId: agent.id }, live.mode);
        } else if (action === 'model') {
          if (!MODEL_RE.test(value ?? '')) {
            return { kind: 'error', text: 'A pinned version such as jev-1.13.0 is required; experimental aliases are refused.' };
          }
          live.model = value;
          persist();
        } else if (action === 'verify') {
          const result = await verifyConnection(signal);
          if (!result.ok) return { kind: 'error', text: `Jev connection failed: ${result.code}.` };
          return { kind: 'success', text: `Jev reachable: ${result.model} / ${result.choice} / ${result.latencyMs}ms` };
        } else if (action !== 'status') {
          return { kind: 'error', text: HELP };
        }
        return { kind: 'success', text: JSON.stringify(await statusReport(agent)) };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // Read-only agent tool. It can never widen authority: no enforce, no resume,
  // no credential access, no budget change.
  // ---------------------------------------------------------------------------
  ctx.effect(() =>
    ctx.tools.register({
      name: 'jev_supervisor_status',
      description:
        'Read Jev supervision state: whether the API is reachable and whether THIS task is still being supervised or is limited. Cannot change mode, credentials or authority.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            mode: { type: 'string' },
            reachable: { type: 'string' },
            supervision: { type: 'string' },
            accounting: { type: 'string' },
            keyConfigured: { type: 'boolean' },
            model: { type: 'string' },
            calls: { type: 'number' },
            callBudget: { type: 'number' },
            interventions: { type: 'number' },
            interventionLimit: { type: 'number' },
            // The limit that stopped this task, or an empty string when none did.
            // A JSON-Schema type array is not supported by the registry.
            limit: { type: 'string' },
          },
          required: [
            'mode',
            'reachable',
            'supervision',
            'accounting',
            'keyConfigured',
            'model',
            'calls',
            'callBudget',
            'interventions',
            'interventionLimit',
            'limit',
          ],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async (_args, exec) => {
        const report = await statusReport(exec.agent);
        return {
          mode: report.mode,
          reachable: report.reachability,
          supervision: report.supervision,
          accounting: report.accounting,
          keyConfigured: report.keyConfigured,
          model: report.model,
          calls: report.calls,
          callBudget: report.callBudget,
          interventions: report.interventions,
          interventionLimit: report.interventionLimit,
          limit: report.limit ?? '',
        };
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // Client bridge. Every operation that changes authority is reachable only from
  // an explicit user gesture in the Harness page, over the authenticated
  // same-origin /api channel.
  // ---------------------------------------------------------------------------
  ctx.inject(['connection'], connectionCtx => {
    const connection = connectionCtx.get('connection');
    if (!connection?.fetch?.register) return;
    connectionCtx.effect(
      () =>
        connection.fetch.register({
          path: `${ROUTE_PREFIX}/status`,
          methods: ['GET'],
          requestBody: 'buffered',
          fetch: async request => {
            // A session-scoped read makes the budget and supervision state the
            // user sees belong to the session they are looking at.
            const agent = agentForSession(url(request).searchParams.get('sessionId'));
            return answer({ ok: true, ...(await statusReport(agent)), details: log.tail().slice(-8) });
          },
        }),
      'jev-supervisor: status route',
    );
    connectionCtx.effect(
      () =>
        connection.fetch.register({
          path: `${ROUTE_PREFIX}/mode`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async request => {
            const body = await readJson(request);
            if (!body) return answer({ ok: false, code: 'bad_request' }, 400);
            if (body.callBudget !== undefined || body.interventionLimit !== undefined) {
              const result = setBudget(body);
              return result.ok ? answer(result) : answer(result, 400);
            }
            if (MODES.includes(body.mode)) return answer({ ok: true, ...setMode(body.mode) });
            if (typeof body.apiEnabled === 'boolean') return answer({ ok: true, ...setApiEnabled(body.apiEnabled) });
            return answer({ ok: false, code: 'bad_request' }, 400);
          },
        }),
      'jev-supervisor: mode route',
    );
    connectionCtx.effect(
      () =>
        connection.fetch.register({
          path: `${ROUTE_PREFIX}/verify`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async request => answer({ ok: true, ...(await verifyConnection(request.signal)) }),
        }),
      'jev-supervisor: verify route',
    );
    // Enabling enforcement is one user gesture: prove the credential works, then
    // switch. A failed check leaves the mode exactly as it was.
    connectionCtx.effect(
      () =>
        connection.fetch.register({
          path: `${ROUTE_PREFIX}/enable-enforce`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async request => {
            const probeResult = await verifyConnection(request.signal);
            if (!probeResult.ok) return answer({ ok: false, code: probeResult.code, enabled: false });
            const mode = setMode('enforce');
            // Enabling enforcement is itself the decision the first-run setup
            // was asking for, so the setup is done.
            setOnboarded(true);
            return answer({ ok: true, enabled: true, ...mode, verified: probeResult });
          },
        }),
      'jev-supervisor: enforce route',
    );
    connectionCtx.effect(
      () =>
        connection.fetch.register({
          path: `${ROUTE_PREFIX}/resume`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async () => {
            for (const state of supervisor.tasks.values()) state.paused = false;
            persist();
            log.record({ kind: 'resume', action: 'resumed' }, live.mode);
            return answer({ ok: true, paused: false });
          },
        }),
      'jev-supervisor: resume route',
    );
    // "Later" on the first-run setup: recorded durably so it is asked once, not
    // on every start. It grants nothing and changes no mode.
    connectionCtx.effect(
      () =>
        connection.fetch.register({
          path: `${ROUTE_PREFIX}/onboarding`,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async request => {
            const body = await readJson(request);
            if (!body) return answer({ ok: false, code: 'bad_request' }, 400);
            const onboarded = body.onboarded !== false;
            setOnboarded(onboarded);
            return answer({ ok: true, onboarded: live.onboarded });
          },
        }),
      'jev-supervisor: onboarding route',
    );
  });

  log.record(
    {
      kind: 'activated',
      profile: profile?.name ?? null,
      profileDir: profile?.dir ?? null,
      dataDir,
      keyRef,
      model: live.model,
      mode: live.mode,
      generation: sourceGeneration(),
    },
    live.mode,
  );
}

/**
 * Digest of the three files that define supervision behaviour. It identifies
 * which build produced a log line without recording any path.
 * @returns 24 hex characters, or null when the sources cannot be read.
 */
function sourceGeneration() {
  try {
    const files = ['./index.js', './core.js', './adapter.js'].map(file => readFileSync(new URL(file, import.meta.url), 'utf8'));
    return createHash('sha256').update(files.join('\u0000')).digest('hex').slice(0, 24);
  } catch {
    return null;
  }
}

/** Redaction helper exposed for tests: never serializes a live secret. */
export { scrub };
