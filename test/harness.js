/**
 * Integration harness: a real Cordis application with the real Harness tool
 * runtime from the installed Desktop build, plus the few services the plugin
 * reads. Only the services the plugin cannot own in a unit test are stubbed:
 * the agent registry, the session-projection registry, the command registry,
 * the credential seam and the storage domain.
 *
 * The tool registry and its `tools/pre-execute`, guard, `tools/post-execute`
 * and `tools/result` machinery are the real thing, so a denial that is proved
 * here is proved against the same ordering the Desktop build uses.
 */
import { resolveKeyRef } from '../lib/credentials.js';

/** The exact command that prepares the fixture these tests load. */
export const PREPARE_HINT =
  'Integration tests load the real Harness packages. Prepare the fixture once with:\n' +
  '  DSH_TEST_RUNTIME=/path/to/installed/dsh/node_modules \\\n' +
  '  DSH_TEST_PROFILE=~/.dsh/profiles/desktop/node_modules \\\n' +
  '  node test/prepare-runtime.mjs';

/**
 * Load the real Harness packages, naming the fixture when it is missing.
 * @returns the Context class, the tool runtime, its scheduler key and Commands.
 */
async function loadRuntime() {
  try {
    const [{ Context }, tools, commands] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-tools'),
      import('@deepseek-ai/dsh-commands'),
    ]);
    return { Context, ToolRuntime: tools.ToolRuntime, TOOL_RUNTIME_SCHEDULER: tools.TOOL_RUNTIME_SCHEDULER, Commands: commands.default };
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') throw new Error(`${PREPARE_HINT}\n(cause: ${error.message})`);
    throw error;
  }
}

const { Context, ToolRuntime, TOOL_RUNTIME_SCHEDULER, Commands } = await loadRuntime();

/**
 * Minimal `systemPrompt` satisfying what ToolRuntime touches at construction.
 * @param root - the root context, which is where these services are provided.
 */
function stubSystemPrompt(root) {
  const sections = [];
  root.provide('systemPrompt', {
    tools() {
      return () => {};
    },
    section(registration) {
      sections.push(registration);
      return () => {};
    },
    getSectionOrder() {
      return [];
    },
    getContextOrder() {
      return [];
    },
  });
}

/** Session-projection registry with one registered unit per key. */
function stubSessionProjections() {
  const units = new Map();
  const state = new WeakMap();
  return {
    register(definition) {
      units.set(definition.key, definition);
      return () => units.delete(definition.key);
    },
    stateOf(session, key) {
      const unit = units.get(key);
      if (!unit) return undefined;
      let perSession = state.get(session);
      if (!perSession) {
        perSession = new Map();
        state.set(session, perSession);
      }
      if (!perSession.has(key)) perSession.set(key, unit.init({ id: session.id }));
      return perSession.get(key);
    },
    /** Test helper: fold one event into a session's projection. */
    fold(session, key, event) {
      const unit = units.get(key);
      let perSession = state.get(session);
      if (!perSession) {
        perSession = new Map();
        state.set(session, perSession);
      }
      perSession.set(key, unit.apply(perSession.get(key) ?? unit.init({ id: session.id }), event));
    },
  };
}

/**
 * Credential seam with one entry per reference name.
 *
 * The real local provider keeps a single document for the whole harness home, so
 * a shared store like this is what makes the profile-scoping claim testable: two
 * plugin instances in two profiles must address two different entries, and
 * neither may read or overwrite the other's.
 *
 * @param initial - a plain key value, or a map of reference name to value. A
 *   plain value is stored under every name the harness may address it by: the
 *   unscoped base name and the profile-scoped name for the profile in play, so
 *   an existing test does not have to know the derived spelling.
 * @param options - `profileContext`, used to derive the profile-scoped name.
 * @returns the seam plus an inspection helper.
 */
export function createCredentials(initial, { profileContext } = {}) {
  const entries = new Map();
  if (typeof initial === 'string') {
    entries.set('JEV_TYPESAFE_API_KEY', initial);
    entries.set(resolveKeyRef({ profileContext }), initial);
  } else if (initial && typeof initial === 'object') for (const [ref, value] of Object.entries(initial)) entries.set(ref, value);
  return {
    /** Every stored reference name, for isolation assertions. */
    entries: () => [...entries.keys()],
    /**
     * Copy the unscoped value, if any, into this profile's scoped entry.
     * @param profileContext - the profile the plugin instance runs in.
     */
    mirrorTo(profileContext) {
      const scoped = resolveKeyRef({ profileContext });
      const base = entries.get('JEV_TYPESAFE_API_KEY');
      if (base !== undefined && !entries.has(scoped)) entries.set(scoped, base);
    },
    value: ref => entries.get(ref),
    async resolve(ref) {
      const value = entries.get(ref);
      return value === undefined ? undefined : { value, source: 'store' };
    },
    async describe(ref) {
      return { configured: entries.has(ref), writable: true, source: entries.has(ref) ? 'store' : undefined };
    },
    async set(ref, next) {
      entries.set(ref, next);
    },
    async unset(ref) {
      entries.delete(ref);
    },
  };
}

/**
 * Build a live application with the plugin mounted.
 *
 * @param options - `config` overrides, `credentials` seam, `dataDir`.
 * @returns the context, the projection registry, the command registry and a
 *   `close()` that disposes the application.
 */
export async function createApp({
  config = {},
  credentials,
  dataDir,
  profileName = 'test-profile',
  profileDir,
  /**
   * Mount the credential provider this many milliseconds AFTER the plugin
   * activates, reproducing a provider whose service registers only once its own
   * asynchronous init completes. Omitted, the provider is present at activation.
   */
  credentialsDelayMs,
} = {}) {
  const ctx = new Context();
  const projections = stubSessionProjections();
  const agents = new Map();
  const profileContext = { name: profileName, dir: profileDir ?? dataDir ?? process.cwd() };
  const seam = credentials ?? createCredentials(undefined, { profileContext });
  // A test that built its seam before a profile was known still addresses the
  // profile-scoped name: mirror any base value into the derived entry.
  if (typeof seam.mirrorTo === 'function') seam.mirrorTo(profileContext);
  /**
   * Minimal `connection` service: the plugin registers exact Fetch routes on it,
   * and this records them so a test can dispatch a request without HTTP.
   */
  const routes = new Map();
  const connection = {
    fetch: {
      register(route) {
        routes.set(`${route.path} ${route.methods.join(',')}`, route);
        return () => routes.delete(`${route.path} ${route.methods.join(',')}`);
      },
    },
  };
  let disposeCredentials;
  const app = ctx.plugin(function () {
    stubSystemPrompt(ctx);
    // The real provider's service exists only after its file load and watcher
    // setup, so a delayed mount is the honest default to test against.
    if (credentialsDelayMs === undefined) ctx.provide('credentials', seam);
    else disposeCredentials = ctx.provide('credentials', seam);
    ctx.provide('profileContext', profileContext);
    ctx.provide('connection', connection);
    ctx.provide('sessionProjections', projections);
    ctx.provide('agents', {
      list: () => [...agents.values()],
      get: id => agents.get(id),
      requireInitiator: () => undefined,
    });
  });
  await app;
  const toolsFiber = ctx.plugin(ToolRuntime, {});
  await toolsFiber;
  // The real command registry: `/jev` must go through the shipped normalizer.
  const commandsFiber = ctx.plugin(Commands, {});
  await commandsFiber;

  const plugin = await import('../lib/index.js');
  const instance = await ctx.plugin(
    {
      name: plugin.name,
      inject: plugin.inject,
      Config: plugin.Config,
      apply: plugin.apply,
    },
    { ...config, dataDir: dataDir ?? config.dataDir ?? process.cwd() },
  );

  if (process.env.JEV_TRACE) {
    ctx.on('agent/created', payload => console.log('[trace] root saw agent/created', payload?.agent?.id));
  }
  if (credentialsDelayMs !== undefined) {
    // Withdraw the service and hand it back later, simulating a provider that is
    // not ready at activation.
    disposeCredentials();
    setTimeout(() => {
      void ctx.provide('credentials', seam);
    }, credentialsDelayMs).unref?.();
  }

  return {
    ctx,
    plugin,
    instance,
    projections,
    commands: ctx.commands,
    credentials: seam,
    agents,
    /**
     * Dispatch one request through the plugin's own `/api` route, exactly as the
     * Harness connection service would.
     * @param path - route path under the plugin prefix.
     * @param options - `method` and `body`.
     * @returns the parsed JSON answer.
     */
    async route(path, { method = 'GET', body } = {}) {
      // The registered path is the route's pathname; a caller may append a query.
      const pathname = path.split('?')[0];
      const match = [...routes.values()].find(route => route.path === pathname && route.methods.includes(method));
      if (!match) throw new Error(`no route for ${method} ${path}`);
      const request = new Request(`http://127.0.0.1${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      });
      const response = await match.fetch(request);
      return { status: response.status, body: await response.json() };
    },
    /** The route paths this instance registered, for coverage assertions. */
    routePaths: () => [...routes.values()].map(route => `${route.methods.join(',')} ${route.path}`),
    async close() {
      await instance.dispose();
      await ctx.fiber.dispose();
    },
  };
}

/** Register one echo tool whose body records whether it ran. */
export function registerEchoTool(ctx, name = 'echo') {
  const ran = [];
  ctx.effect(() =>
    ctx.tools.register({
      name,
      description: 'test tool that records execution',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: true },
      output: {
        schema: { type: 'object', properties: { echoed: { type: 'string' } }, required: ['echoed'], additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: value.echoed }],
      },
      execute: async args => {
        ran.push(args);
        return { echoed: String(args?.value ?? '') };
      },
    }),
  );
  return ran;
}

/**
 * Drive one call through the real scheduler stages the agent loop uses:
 * prepare (pre-execute + guards) → dispatch (tool body) → finalize
 * (post-execute) → finish.
 */
export async function runTool(ctx, { name, args = {}, agent, callId = 'call-1', signal } = {}) {
  const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER];
  const prepared = await scheduler.prepare({ callId, name, arguments: args, agent, signal: signal ?? new AbortController().signal });
  // A denial, cancellation or approval gate ends the call here: the body never
  // runs, and the scheduler still owns the materialized result.
  if (prepared.kind !== 'dispatch') {
    // A gate settled before dispatch (deny, cancel, approval, or a preparation
    // failure). `final-result` still needs finalization; `post-result` is ready.
    const result = prepared.kind === 'final-result' ? await scheduler.finish(prepared.exec, prepared.result) : prepared.result;
    return { executed: false, result };
  }
  const outcome = await scheduler.dispatch(prepared.exec);
  if (outcome.kind !== 'post-result') {
    // A dispatch-stage failure skips post-execute and settles directly.
    return { executed: true, result: await scheduler.finish(prepared.exec, outcome.result) };
  }
  // Post-execute policy runs over the committed result before it is announced.
  const finalResult = await scheduler.finalize(prepared.exec, outcome.result);
  return { executed: true, result: finalResult };
}
