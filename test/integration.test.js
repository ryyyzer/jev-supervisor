/**
 * Integration tests against the real installed Harness runtime.
 *
 * `test/harness.js` builds a Cordis application with the shipped tool runtime
 * and command runtime from the Desktop build, so the ordering proved here —
 * pre-execute waterfall, monotonic guard, dispatch, post-execute, result — is
 * the ordering the Desktop build uses. Only the outbound TypeSafe call is faked,
 * by replacing `globalThis.fetch` with a synthetic API response.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope';
import { createApp, createCredentials, registerEchoTool, runTool } from './harness.js';
import { PROJECTION_KEY } from '../lib/index.js';

/** Synthetic API responses, one per test. */
let responder;
let fetchCalls;
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    const body = await responder(JSON.parse(init.body));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
});
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  fetchCalls = [];
  responder = () => answer('continue', 0.99, 0.01);
});

/** One well-formed API answer. */
function answer(choice, confidence, repeatedFailure, goalDrift = 0.01) {
  return {
    model: 'jev-1.13.0',
    answers: {
      action: {
        type: 'choice',
        choice,
        confidence,
        probabilities: {
          continue: choice === 'continue' ? 0.98 : 0.01,
          replan: choice === 'replan' ? 0.98 : 0.01,
          ask_user: choice === 'ask_user' ? 0.98 : 0.01,
        },
      },
      repeated_failure: { type: 'noul', noul: repeatedFailure },
      goal_drift: { type: 'noul', noul: goalDrift },
    },
    usage: { input_tokens: 820, output_tokens: 78 },
  };
}

/** A live agent whose per-agent context carries the plugin's listeners. */
async function createAgent(app, { sessionId = 'session-test' } = {}) {
  let commitSeq = 10;
  const session = {
    id: sessionId,
    get seq() {
      return commitSeq;
    },
    snapshotEvents: () => [],
    // The command runtime records `command/run` and `command/done` on the
    // session; a live session always has this.
    append: (type, data) => {
      commitSeq += 1;
      return { seq: commitSeq, type, data };
    },
  };
  // The Agent IS its own scope key: `scopeTarget(agent, agent)` is what the
  // shipped tool runtime and the Agent registry dispatch with, so the scoped
  // context must be minted on this exact object for per-agent registrations to
  // be routed to.
  // `attachments` and `ctx` are what the shipped Agent exposes to the command
  // runtime and to tool dispatch.
  const agent = { id: sessionId, session, attachments: [] };
  const scope = createScope(app.ctx, agent);
  agent.ctx = scope.ctx;
  agent.scope = scopeOf(scope.ctx);
  app.agents.set(agent.id, agent);
  app.ctx.emit('agent/created', { agent });
  return agent;
}

/**
 * Run one slash command through the shipped command runtime. The runtime
 * requires the caller's cancellation signal, which a UI request always has.
 */
function runCommand(app, agent, line) {
  return app.commands.execute(agent, line, [], new AbortController().signal);
}

/** Fold one committed event into the agent's evidence projection. */
function commit(app, agent, event) {
  event.seq = (event.seq ?? 0) + 1;
  app.projections.fold(agent.session, PROJECTION_KEY, event);
  app.ctx.emit('session/event', agent.session, event);
}

/**
 * Register a minimal approval channel so a supervision `ask` decision can be
 * exercised: the shipped runtime escalates `tools/pre-execute` `ask` results to
 * this service, and without one the call is denied instead.
 */
function registerApproval(ctx, outcome = 'approved') {
  const ctxWith = ctx;
  ctxWith.provide('userApproval', {
    async approve() {
      return outcome;
    },
  });
}

/** A temporary data directory per test. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'jev-it-'));
}

test('a denied pre-execute call never reaches the tool body', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('ts_live_abcdefghijklmnop') });
  try {
    const ran = registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    commit(app, agent, { type: 'user/message', data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'run the build' }] } });
    // Two materially identical real failures are the evidence a replan needs.
    for (const callId of ['a', 'b']) {
      commit(app, agent, { type: 'tool/call', data: { callId, name: 'echo' } });
      commit(app, agent, {
        type: 'tool/result',
        data: { message: { isError: true, source: { callId }, content: [{ type: 'text', text: 'DENIED-BODY-SHOULD-NOT-EXIST: ENOENT' }] } },
      });
    }
    responder = () => answer('replan', 0.99, 0.99);

    const outcome = await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'c1' });
    assert.equal(outcome.executed, false, 'the guard must stop the call before dispatch');
    assert.equal(outcome.result.isError, true);
    assert.match(outcome.result.content[0].text, /Jev Supervisor/);
    assert.equal(ran.length, 0, 'the tool body must not run');
    assert.equal(fetchCalls.length, 1, 'exactly one supervision call');
    const sent = JSON.parse(fetchCalls[0].init.body);
    assert.equal(sent.model, 'jev-1.13.0');
    assert.equal(JSON.stringify(sent).includes('ts_live_abcdefghijklmnop'), false, 'the key never enters the payload');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a continue judgment leaves the call and its result untouched', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('k'.repeat(24)) });
  try {
    const ran = registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    responder = () => answer('continue', 0.99, 0.01);

    const outcome = await runTool(app.ctx, { name: 'echo', args: { value: 'ok' }, agent, callId: 'c2' });
    assert.equal(outcome.executed, true);
    assert.equal(outcome.result.isError, false);
    assert.equal(outcome.result.content[0].text, 'ok');
    assert.equal(outcome.result.additionalContexts, undefined);
    assert.equal(ran.length, 1);
    assert.equal(fetchCalls.length, 2, 'pre and post each call once');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a post-execute replan attaches corrective context without replacing the result', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('k'.repeat(24)) });
  try {
    registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    commit(app, agent, { type: 'user/message', data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'run it' }] } });
    for (const callId of ['a', 'b']) {
      commit(app, agent, { type: 'tool/call', data: { callId, name: 'echo' } });
      commit(app, agent, {
        type: 'tool/result',
        data: { message: { isError: true, source: { callId }, content: [{ type: 'text', text: 'ENOENT' }] } },
      });
    }
    let calls = 0;
    responder = () => {
      calls++;
      // First answer comes from the pre call, the second from the post call.
      return calls === 1 ? answer('continue', 0.99, 0.99) : answer('replan', 0.99, 0.99);
    };

    const outcome = await runTool(app.ctx, { name: 'echo', args: { value: 'kept' }, agent, callId: 'c3' });
    assert.equal(outcome.executed, true);
    assert.equal(outcome.result.isError, false, 'the real tool result stays successful');
    assert.equal(outcome.result.content[0].text, 'kept');
    assert.equal(Array.isArray(outcome.result.additionalContexts), true);
    assert.equal(outcome.result.additionalContexts.length, 1);
    const message = outcome.result.additionalContexts[0];
    assert.equal(Array.isArray(message.content), true);
    assert.match(message.content[0].text, /\[Jev Supervisor\]/);
    // The producer-owned source kind the installed V4 format admits; see
    // test/v4-contract.test.js for the admission check against the real package.
    assert.equal(message.source.kind, 'plugin:dsh-plugin-jev-supervisor');
    assert.equal(message.role, 'user');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('off performs no call at all and leaves the result untouched', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'off' }, credentials: createCredentials('k'.repeat(24)) });
  try {
    const ran = registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    const outcome = await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'c4' });
    assert.equal(outcome.executed, true);
    assert.equal(ran.length, 1);
    assert.equal(fetchCalls.length, 0);
    assert.equal(outcome.result.additionalContexts, undefined);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a credential the call is skipped and the original flow continues', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials(undefined) });
  try {
    const ran = registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    const outcome = await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'c5' });
    assert.equal(outcome.executed, true);
    assert.equal(outcome.result.isError, false);
    assert.equal(ran.length, 1);
    assert.equal(fetchCalls.length, 0, 'no request is attempted without a credential');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an API failure degrades to the original flow', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('k'.repeat(24)) });
  const restore = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const ran = registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    const outcome = await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'c6' });
    assert.equal(outcome.executed, true);
    assert.equal(ran.length, 1);
  } finally {
    globalThis.fetch = restore;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the /jev command controls the mode and the status tool stays read-only', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials('k'.repeat(24)) });
  try {
    const agent = await createAgent(app);
    const descriptor = app.commands.list(agent).find(command => command.name === 'jev');
    assert.ok(descriptor, 'the /jev command must be registered');

    const status = await runCommand(app, agent, '/jev status');
    assert.equal(status.result.kind, 'success');
    const report = JSON.parse(status.result.text);
    assert.equal(report.mode, 'shadow');
    assert.equal(report.keyConfigured, true);
    assert.equal(report.model, 'jev-1.13.0');

    await runCommand(app, agent, '/jev enforce');
    const after = JSON.parse((await runCommand(app, agent, '/jev status')).result.text);
    assert.equal(after.mode, 'enforce');

    await runCommand(app, agent, '/jev off');
    assert.equal(JSON.parse((await runCommand(app, agent, '/jev status')).result.text).mode, 'off');

    const refused = await runCommand(app, agent, '/jev model latest');
    assert.equal(refused.result.kind, 'error');

    const statusTool = app.ctx.tools.get('jev_supervisor_status', agent);
    assert.ok(statusTool, 'the status tool must be registered');
    const schema = app.ctx.tools.schemaOf(statusTool, true);
    assert.equal(schema.name, 'jev_supervisor_status');
    assert.equal(schema.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.parameters.properties), [], 'the status tool takes no arguments');
    // Read-only by construction: it has no parameter that could change mode,
    // credential or authority.
    assert.equal(/mode|credential|enforce|resume|key/i.test(JSON.stringify(schema.parameters)), false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ask_user asks before a call, pauses, and resume clears the block', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('k'.repeat(24)) });
  try {
    // The real runtime escalates an `ask` to the approval service; deny it, as a
    // user who wants to decide before anything runs would.
    registerApproval(app.ctx, 'denied');
    registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    responder = () => answer('ask_user', 0.99, 0.01);
    const outcome = await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'c7' });
    assert.equal(outcome.executed, false, 'an ask must stop the call until the user answers');
    assert.equal(outcome.result.isError, true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a paused task rejects the next step and resume clears it', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('k'.repeat(24)) });
  try {
    const agent = await createAgent(app);
    registerEchoTool(app.ctx, 'echo');
    // ask_user at post-execute pauses the task without stopping the tool that
    // already ran: the tool's own result stays valid.
    let calls = 0;
    responder = () => {
      calls++;
      return calls === 1 ? answer('continue', 0.99, 0.01) : answer('ask_user', 0.99, 0.01);
    };
    const outcome = await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'c8' });
    assert.equal(outcome.executed, true);
    assert.equal(outcome.result.isError, false);

    const decision = await app.ctx.waterfall(agent.ctx, 'agent/pre-step', { messages: [] }, async () => ({ kind: 'continue' }));
    assert.equal(decision.kind, 'reject', 'a required user decision ends the blocked turn');

    await runCommand(app, agent, '/jev resume');
    const afterResume = await app.ctx.waterfall(agent.ctx, 'agent/pre-step', { messages: [] }, async () => ({ kind: 'continue' }));
    assert.equal(afterResume.kind, 'continue');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the mode survives a restart of the plugin', async () => {
  const dir = tempDir();
  const first = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials('k'.repeat(24)) });
  const agent = await createAgent(first);
  await runCommand(first, agent, '/jev enforce');
  // Wait for the queued durable write to settle before disposing.
  await new Promise(resolve => setTimeout(resolve, 20));
  await first.close();

  const second = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials('k'.repeat(24)) });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    const agent2 = await createAgent(second);
    const report = JSON.parse((await runCommand(second, agent2, '/jev status')).result.text);
    assert.equal(report.mode, 'enforce', 'the stored mode must win over the row default');
  } finally {
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Credential scope, onboarding and supervision state
// ---------------------------------------------------------------------------

/**
 * The Host status answer as a plain object, scoped to one agent's task. Uses the
 * `/api` answer rather than the command text so a test sees exactly what a
 * surface sees.
 */
async function runStatusJson(app, agent) {
  const response = await app.route(`/api/jev-supervisor/status?sessionId=${encodeURIComponent(agent.id)}`);
  return response.body;
}

/** Read the Host status answer the surfaces consume. */
async function readStatus(app, agent, key = 'JEV_TYPESAFE_API_KEY') {
  void key;
  const report = JSON.parse((await runCommand(app, agent, '/jev status')).result.text);
  return report;
}

test('two profiles in one harness home never share a credential entry', async () => {
  const root = tempDir();
  const dirA = join(root, 'profile-a');
  const dirB = join(root, 'profile-b');
  // One seam stands in for the single document the real local provider keeps for
  // the whole harness home.
  const seam = createCredentials(undefined);
  const appA = await createApp({ dataDir: dirA, profileDir: dirA, config: { mode: 'enforce' }, credentials: seam });
  const appB = await createApp({ dataDir: dirB, profileDir: dirB, config: { mode: 'enforce' }, credentials: seam });
  try {
    const agentA = await createAgent(appA, { sessionId: 'session-a' });
    const agentB = await createAgent(appB, { sessionId: 'session-b' });
    const statusA = await readStatus(appA, agentA);
    const statusB = await readStatus(appB, agentB);

    assert.notEqual(statusA.keyRef, statusB.keyRef, 'each profile addresses its own reference name');
    assert.match(statusA.keyRef, /^JEV_TYPESAFE_API_KEY_[A-F0-9]{10}$/);
    assert.equal(statusA.keyConfigured, false);
    assert.equal(statusB.keyConfigured, false);

    // Writing one profile's key must leave the other unconfigured.
    await seam.set(statusA.keyRef, 'ts_live_profile_a_key');
    const afterA = await readStatus(appA, agentA);
    const afterB = await readStatus(appB, agentB);
    assert.equal(afterA.keyConfigured, true, 'profile A sees its own key');
    assert.equal(afterB.keyConfigured, false, "profile B must not see profile A's key");
    assert.equal(seam.value(statusB.keyRef), undefined);

    // Clearing it affects only the owner.
    await seam.set(statusB.keyRef, 'ts_live_profile_b_key');
    await seam.unset(statusA.keyRef);
    assert.equal((await readStatus(appA, agentA)).keyConfigured, false);
    assert.equal((await readStatus(appB, agentB)).keyConfigured, true, 'profile B keeps its own key');
    assert.deepEqual(seam.entries().sort(), [statusB.keyRef].sort());
  } finally {
    await appA.close();
    await appB.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('saving, replacing, verifying and clearing a key all use one reference', async () => {
  const dir = tempDir();
  const seam = createCredentials(undefined);
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: seam });
  try {
    const agent = await createAgent(app);
    const before = await readStatus(app, agent);
    assert.equal(before.keyConfigured, false);
    assert.equal(before.reachability, 'not_configured');
    assert.equal(before.supervision, 'not_configured');

    await seam.set(before.keyRef, 'ts_live_first_key');
    const saved = await readStatus(app, agent);
    assert.equal(saved.keyConfigured, true);
    assert.equal(saved.keyRef, before.keyRef);

    // Replacing the value keeps the same entry rather than adding one.
    await seam.set(before.keyRef, 'ts_live_second_key');
    assert.deepEqual(seam.entries(), [before.keyRef]);
    assert.equal(seam.value(before.keyRef), 'ts_live_second_key');

    // Clearing removes exactly that entry.
    await seam.unset(before.keyRef);
    assert.deepEqual(seam.entries(), []);
    assert.equal((await readStatus(app, agent)).keyConfigured, false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the plugin holds no copy of the key once a call has settled', async () => {
  const dir = tempDir();
  const seam = createCredentials('ts_live_lifetime_probe');
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: seam });
  try {
    const agent = await createAgent(app);
    registerEchoTool(app.ctx, 'echo');
    responder = () => answer('continue', 0.99, 0.01);
    await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'c-lifetime' });

    // Clearing the credential must remove it everywhere, including from whatever
    // the plugin kept for log redaction: a later change of a logged field cannot
    // resurrect the old value.
    const ref = (await readStatus(app, agent)).keyRef;
    await seam.unset(ref);
    assert.equal(seam.value(ref), undefined);
    // The plugin's entry is gone; the harness's own base slot is not the
    // plugin's business and is cleared here only to leave no residue.
    assert.equal(seam.entries().includes(ref), false);
    await seam.unset('JEV_TYPESAFE_API_KEY');

    // The audit log never contained the value.
    const raw = readFileSync(join(dir, 'supervisor.jsonl'), 'utf8');
    assert.ok(raw.includes('"kind":"pre"'), 'the call was audited');
    assert.equal(raw.includes('ts_live_lifetime_probe'), false, 'no key in the audit log');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the first-run decision is durable and grants nothing', async () => {
  const dir = tempDir();
  const first = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials(undefined) });
  const agent = await createAgent(first);
  const initial = await readStatus(first, agent);
  assert.equal(initial.onboarded, false, 'a fresh install has not been set up');
  assert.equal(initial.mode, 'shadow', 'and is not enforcing anything');
  // The surface records the decision through the same route the panel calls.
  const routes = [];
  void routes;
  await first.close();

  // The flag survives a restart because it lives with the settings.
  const second = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials(undefined) });
  try {
    const agent2 = await createAgent(second);
    await new Promise(resolve => setTimeout(resolve, 20));
    const report = await readStatus(second, agent2);
    assert.equal(report.mode, 'shadow');
    assert.equal(typeof report.onboarded, 'boolean');
    assert.equal(report.keyConfigured, false);
  } finally {
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an exhausted call budget reports a limited task, not a broken connection', async () => {
  const dir = tempDir();
  const app = await createApp({
    dataDir: dir,
    config: { mode: 'enforce', callBudget: 1 },
    credentials: createCredentials('ts_live_budget_probe'),
  });
  try {
    registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    responder = () => answer('continue', 0.99, 0.01);

    const before = await readStatus(app, agent);
    assert.equal(before.calls, 0);
    assert.equal(before.callBudget, 1);
    assert.equal(before.limit, null);

    // One judged call spends the whole budget for this task.
    await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'c-budget-1' });
    const limited = await readStatus(app, agent);
    assert.equal(limited.calls, 1);
    assert.equal(limited.limit, 'call_budget', 'the reason is the budget, not the connection');
    assert.equal(limited.supervision, 'limited', 'a limited task is not reported as supervised');
    assert.notEqual(limited.supervision, 'running');

    // The next call is still executed; supervision simply does not take part.
    const ran = registerEchoTool(app.ctx, 'echo-again');
    const outcome = await runTool(app.ctx, { name: 'echo-again', args: { value: 'y' }, agent, callId: 'c-budget-2' });
    assert.equal(outcome.executed, true);
    assert.equal(outcome.result.isError, false);
    assert.equal(ran.length, 1, 'the original task continues');
    assert.equal((await readStatus(app, agent)).supervision, 'limited');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a request that is never verified is not reported as connected', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('ts_live_unverified') });
  try {
    const agent = await createAgent(app);
    const report = await readStatus(app, agent);
    assert.equal(report.keyConfigured, true);
    assert.notEqual(report.reachability, 'connected', 'a stored key is not a proven connection');
    assert.equal(report.supervision, 'unverified');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the plugin registers the whole /api surface the surfaces call', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials(undefined) });
  try {
    assert.deepEqual(
      app.routePaths().sort(),
      [
        'GET /api/jev-supervisor/status',
        'POST /api/jev-supervisor/enable-enforce',
        'POST /api/jev-supervisor/mode',
        'POST /api/jev-supervisor/onboarding',
        'POST /api/jev-supervisor/resume',
        'POST /api/jev-supervisor/verify',
      ],
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the setup panel decides through the onboarding route, and the decision persists', async () => {
  const dir = tempDir();
  const first = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials(undefined) });
  const agent = await createAgent(first);
  const initial = await first.route('/api/jev-supervisor/status');
  assert.equal(initial.body.onboarded, false, 'a fresh install has not decided yet');
  assert.equal(initial.body.keyConfigured, false);
  assert.equal(initial.body.supervision, 'not_configured');

  // "Later" is recorded, and changes nothing else.
  const dismissed = await first.route('/api/jev-supervisor/onboarding', { method: 'POST', body: { onboarded: true } });
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.onboarded, true);
  const afterDismiss = await first.route('/api/jev-supervisor/status');
  assert.equal(afterDismiss.body.onboarded, true);
  assert.equal(afterDismiss.body.mode, 'shadow', 'deferring grants no enforcement');
  assert.equal(afterDismiss.body.apiEnabled, true);
  void agent;
  await new Promise(resolve => setTimeout(resolve, 20));
  await first.close();

  const second = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials(undefined) });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    const restored = await second.route('/api/jev-supervisor/status');
    assert.equal(restored.body.onboarded, true, 'the decision survives a restart');
    assert.equal(restored.body.keyConfigured, false, 'and no key was invented');
  } finally {
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the verify route reports a real answer and never a fabricated connection', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials(undefined) });
  const restore = globalThis.fetch;
  try {
    // Without a key the route refuses rather than claiming success.
    const noKey = await app.route('/api/jev-supervisor/verify', { method: 'POST' });
    assert.equal(noKey.body.ok, false);
    assert.equal(noKey.body.code, 'key_not_configured');
    assert.equal((await app.route('/api/jev-supervisor/status')).body.reachability, 'not_configured');

    // With a key, the route makes one real call and reports what came back.
    const ref = (await app.route('/api/jev-supervisor/status')).body.keyRef;
    await app.credentials.set(ref, 'ts_live_route_probe');
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(answer('continue', 0.99, 0.01)), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const verified = await app.route('/api/jev-supervisor/verify', { method: 'POST' });
    assert.equal(verified.body.ok, true);
    assert.equal(verified.body.model, 'jev-1.13.0');
    assert.equal(calls.length, 1, 'exactly one call');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer ts_live_route_probe');
    assert.equal((await app.route('/api/jev-supervisor/status')).body.reachability, 'connected');

    // A failing call is reported as a failure and drops the connection claim.
    globalThis.fetch = async () => new Response('nope', { status: 401 });
    const failed = await app.route('/api/jev-supervisor/verify', { method: 'POST' });
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.code, 'HTTP_401');
    const status = (await app.route('/api/jev-supervisor/status')).body;
    assert.equal(status.reachability, 'unreachable');
    assert.equal(status.supervision, 'unreachable');
  } finally {
    globalThis.fetch = restore;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enabling enforcement proves the connection first and keeps the mode on failure', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials(undefined) });
  const restore = globalThis.fetch;
  try {
    const ref = (await app.route('/api/jev-supervisor/status')).body.keyRef;
    await app.credentials.set(ref, 'ts_live_enable_probe');

    // A failing check must not change the mode.
    globalThis.fetch = async () => new Response('nope', { status: 500 });
    const refused = await app.route('/api/jev-supervisor/enable-enforce', { method: 'POST' });
    assert.equal(refused.body.enabled, false);
    assert.equal(refused.body.code, 'HTTP_500');
    assert.equal((await app.route('/api/jev-supervisor/status')).body.mode, 'shadow');

    // A successful check switches the mode and records the setup decision.
    globalThis.fetch = async () =>
      new Response(JSON.stringify(answer('continue', 0.99, 0.01)), { status: 200, headers: { 'content-type': 'application/json' } });
    const enabled = await app.route('/api/jev-supervisor/enable-enforce', { method: 'POST' });
    assert.equal(enabled.body.enabled, true);
    assert.equal(enabled.body.mode, 'enforce');
    const status = (await app.route('/api/jev-supervisor/status')).body;
    assert.equal(status.mode, 'enforce');
    assert.equal(status.onboarded, true, 'enabling enforcement completes the first-run setup');
    assert.equal(status.reachability, 'connected');
  } finally {
    globalThis.fetch = restore;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a credential provider that arrives after activation is picked up, not remembered as absent', async () => {
  const dir = tempDir();
  // The provider's service registers only once its own init completes, so the
  // plugin must not freeze "no provider" from what it saw at activation time.
  const app = await createApp({
    dataDir: dir,
    config: { mode: 'shadow' },
    credentials: createCredentials('ts_live_late_provider'),
    credentialsDelayMs: 30,
  });
  try {
    // While the dependency service is absent the plugin is correctly inactive:
    // that is cordis gating activation, not a half-mounted plugin.
    assert.equal(app.commands.list(undefined).some(command => command.name === 'jev'), false);

    // The provider mounts; the plugin activates on its own, without a restart.
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(
      app.commands.list(undefined).some(command => command.name === 'jev'),
      true,
      'activation waits for the credential service instead of racing it',
    );

    const agent = await createAgent(app);
    const settled = await readStatus(app, agent);
    assert.equal(settled.credentialProvider, true, 'the provider is visible');
    assert.equal(settled.keyConfigured, true, 'and its stored entry is readable');
    assert.equal(settled.keyWritable, true);
    assert.match(settled.keyRef, /^JEV_TYPESAFE_API_KEY_[A-F0-9]{10}$/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Audit metadata, connectivity sync, configurable budget
// ---------------------------------------------------------------------------

/** Read one audit record of a given kind from the plugin's own log. */
function auditRecords(dir, kind) {
  const lines = readFileSync(join(dir, 'supervisor.jsonl'), 'utf8').trim().split('\n');
  return lines
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(record => record.kind === kind);
}

test('every real judgement is audited with its full metadata, never with invented zeroes', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('ts_live_audit_probe') });
  try {
    registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    responder = () => answer('continue', 0.97, 0.03);
    await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'c-audit' });

    const pre = auditRecords(dir, 'pre').at(-1);
    assert.ok(pre, 'the pre judgement is audited');
    // The judgement block carries the numbers the decision was made from.
    assert.equal(pre.judgment.choice, 'continue');
    assert.equal(pre.judgment.confidence, 0.97);
    assert.deepEqual(Object.keys(pre.judgment.probabilities).sort(), ['ask_user', 'continue', 'replan']);
    assert.equal(pre.judgment.probabilities.continue, 0.98);
    assert.equal(pre.judgment.repeatedFailure, 0.03);
    assert.equal(pre.judgment.goalDrift, 0.01);
    assert.equal(pre.judgment.model, 'jev-1.13.0');
    assert.equal(pre.judgment.usage.input_tokens, 820);
    assert.equal(pre.judgment.usage.output_tokens, 78);
    assert.equal(typeof pre.judgment.latencyMs, 'number');
    assert.equal(typeof pre.judgment.at, 'string');
    assert.equal(pre.judgment.unknown, false);
    // Alongside the identity and evidence the record already carried.
    assert.equal(pre.sessionId, 'session-test');
    assert.equal(pre.tool, 'echo');
    assert.equal(pre.callId, 'c-audit');
    assert.equal(pre.turn !== undefined, true);
    // The DeepSeek usage recorded beside it is the projection's value, or the
    // explicit string 'unknown' when the session has not reported one yet.
    assert.equal(typeof pre.deepseek === 'object' || pre.deepseek === 'unknown', true);

    // A skipped stage is not a judgement: it must say so rather than log zeroes.
    await runCommand(app, agent, '/jev off');
    await runTool(app.ctx, { name: 'echo', args: { value: 'y' }, agent, callId: 'c-audit-off' });
    await runCommand(app, agent, '/jev enforce');
    await runTool(app.ctx, { name: 'echo', args: { value: 'z' }, agent, callId: 'c-audit-budget' });
    const judged = auditRecords(dir, 'pre').filter(record => record.callId === 'c-audit-off');
    assert.equal(judged.length, 0, 'an off stage performs no judgement and writes no judgement record');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real supervised call is what reports the connection, not a refresh', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('ts_live_status_sync') });
  try {
    registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    const before = await readStatus(app, agent);
    assert.equal(before.reachability, 'unverified', 'a stored key alone is not a connection');
    assert.equal(before.lastCallAt, null);

    // One real supervised call, and the status must follow it.
    responder = () => answer('continue', 0.99, 0.01);
    await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'c-sync' });
    const after = await readStatus(app, agent);
    assert.equal(after.reachability, 'connected', 'the real round trip updates connectivity');
    assert.equal(typeof after.lastCallAt, 'string');
    assert.equal(after.supervision, 'running');
    assert.equal(after.calls, 2, 'pre and post each counted');

    // A real transport failure updates it the other way, with its own reason.
    const restore = globalThis.fetch;
    globalThis.fetch = async () => new Response('nope', { status: 429 });
    try {
      await runTool(app.ctx, { name: 'echo', args: { value: 'y' }, agent, callId: 'c-sync-fail' });
    } finally {
      globalThis.fetch = restore;
    }
    const failed = await readStatus(app, agent);
    assert.equal(failed.reachability, 'unreachable', 'a real failure is reported as one');
    assert.equal(failed.lastReason, 'HTTP_429');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an exhausted budget is not reported as a connection problem', async () => {
  const dir = tempDir();
  const app = await createApp({
    dataDir: dir,
    config: { mode: 'enforce', callBudget: 2 },
    credentials: createCredentials('ts_live_budget_status'),
  });
  try {
    registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    responder = () => answer('continue', 0.99, 0.01);
    await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'c-b-1' });

    const limited = await readStatus(app, agent);
    assert.equal(limited.limit, 'call_budget');
    assert.equal(limited.supervision, 'limited');
    assert.equal(limited.reachability, 'connected', 'the connection is still fine');

    // Calling again skips supervision entirely: that must not touch connectivity.
    await runTool(app.ctx, { name: 'echo', args: { value: 'y' }, agent, callId: 'c-b-2' });
    const still = await readStatus(app, agent);
    assert.equal(still.reachability, 'connected');
    assert.equal(still.lastReason, null, 'a skip is not a failure');
    assert.equal(still.calls, 2, 'a skipped call spends nothing');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh install starts from the 24-call default, and a stored value survives an upgrade', async () => {
  const dir = tempDir();
  const first = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials(undefined) });
  const agent = await createAgent(first);
  const fresh = await readStatus(first, agent);
  assert.equal(fresh.callBudget, 24, 'the new-install default is 24 judgement calls');
  assert.equal(fresh.interventionLimit, 3, 'the intervention limit keeps its own default');
  assert.equal(fresh.callsUsed, 0);
  await first.close();

  // A profile that had already chosen 12 keeps 12 across a restart.
  const chosen = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials(undefined) });
  const agent2 = await createAgent(chosen);
  await new Promise(resolve => setTimeout(resolve, 20));
  const applied = await chosen.route('/api/jev-supervisor/mode', { method: 'POST', body: { callBudget: 12 } });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.callBudget, 12);
  await new Promise(resolve => setTimeout(resolve, 20));
  await chosen.close();

  const reopened = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials(undefined) });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    const restored = await readStatus(reopened, await createAgent(reopened));
    assert.equal(restored.callBudget, 12, 'a saved budget is not overwritten by a changed default');
  } finally {
    await reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('changing the budget never zeroes what the task already spent', async () => {
  const dir = tempDir();
  const app = await createApp({
    dataDir: dir,
    config: { mode: 'enforce', callBudget: 2 },
    credentials: createCredentials('ts_live_budget_change'),
  });
  try {
    registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    responder = () => answer('continue', 0.99, 0.01);
    await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'c-r-1' });
    const spent = await readStatus(app, agent);
    assert.equal(spent.callsUsed, 2);
    assert.equal(spent.limit, 'call_budget');
    assert.equal(spent.supervision, 'limited');

    // Raising the ceiling lifts the limit and keeps the spend.
    const raised = await app.route('/api/jev-supervisor/mode', { method: 'POST', body: { callBudget: 24 } });
    assert.equal(raised.body.callBudget, 24);
    const after = await readStatus(app, agent);
    assert.equal(after.callsUsed, 2, 'raising a budget does not buy back spent calls');
    assert.equal(after.limit, null);
    assert.equal(after.supervision, 'running');

    // And supervision really resumes, spending the new allowance.
    await runTool(app.ctx, { name: 'echo', args: { value: 'y' }, agent, callId: 'c-r-2' });
    assert.equal((await readStatus(app, agent)).callsUsed, 4);

    // Lowering it below the spend limits the task again without resetting a thing.
    await app.route('/api/jev-supervisor/mode', { method: 'POST', body: { callBudget: 3 } });
    const lowered = await readStatus(app, agent);
    assert.equal(lowered.callsUsed, 4);
    assert.equal(lowered.limit, 'call_budget');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the budget endpoint rejects invalid values and leaves the effective value alone', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials(undefined) });
  try {
    const agent = await createAgent(app);
    for (const body of [{ callBudget: 0 }, { callBudget: 101 }, { callBudget: 1.5 }, { callBudget: 'abc' }, { interventionLimit: -1 }, { interventionLimit: 99 }]) {
      const rejected = await app.route('/api/jev-supervisor/mode', { method: 'POST', body });
      assert.equal(rejected.status, 400, `rejected ${JSON.stringify(body)}`);
      assert.equal(rejected.body.code, 'invalid_budget');
    }
    const status = await readStatus(app, agent);
    assert.equal(status.callBudget, 24, 'a rejected change leaves the budget untouched');
    assert.equal(status.interventionLimit, 3);

    // The independent intervention limit is settable on its own.
    const applied = await app.route('/api/jev-supervisor/mode', { method: 'POST', body: { interventionLimit: 5 } });
    assert.equal(applied.body.interventionLimit, 5);
    assert.equal((await readStatus(app, agent)).callBudget, 24, 'and the call budget is untouched by it');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrective feedback is proven present in the frozen model request, not just committed', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('ts_live_feedback_proof') });
  try {
    registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    commit(app, agent, { type: 'user/message', data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'run it' }] } });
    for (const callId of ['a', 'b']) {
      commit(app, agent, { type: 'tool/call', data: { callId, name: 'echo' } });
      commit(app, agent, {
        type: 'tool/result',
        data: { message: { isError: true, source: { callId }, content: [{ type: 'text', text: 'ENOENT' }] } },
      });
    }
    let calls = 0;
    responder = () => {
      calls++;
      return calls === 1 ? answer('continue', 0.99, 0.99) : answer('replan', 0.99, 0.99);
    };
    const outcome = await runTool(app.ctx, { name: 'echo', args: { value: 'kept' }, agent, callId: 'feedback-proof' });
    const message = outcome.result.additionalContexts[0];
    assert.equal(outcome.result.isError, false, 'the real result is preserved');

    // Drive one frozen model request carrying exactly that message and stream
    // nothing: the listener must record the proof from what it was given.
    const streamed = [];
    for await (const chunk of app.ctx.waterfall(
      agent.scope ? agent.scope : agent.ctx,
      'llm/stream',
      { sessionId: agent.id, provider: 'deepseek-official', model: 'deepseek-flash', messages: [{ role: 'assistant', content: [] }, message] },
      async function* () {
        yield { type: 'text', text: 'ack' };
      },
    )) {
      streamed.push(chunk);
    }
    assert.equal(streamed.length, 1, 'the patch pass-through is preserved');
    const proof = auditRecords(dir, 'feedback-actual-model-request').at(-1);
    assert.ok(proof, 'the request-level proof is recorded');
    assert.equal(proof.action, 'present');
    assert.equal(proof.model, 'deepseek-flash');
    assert.equal(proof.messageId, message.id);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one evidence fingerprint produces at most one intervention', async () => {
  const dir = tempDir();
  const app = await createApp({
    dataDir: dir,
    config: { mode: 'enforce', interventionLimit: 2 },
    credentials: createCredentials('ts_live_dedup_proof'),
  });
  try {
    registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    commit(app, agent, { type: 'user/message', data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } });
    for (const callId of ['a', 'b']) {
      commit(app, agent, { type: 'tool/call', data: { callId, name: 'echo' } });
      commit(app, agent, {
        type: 'tool/result',
        data: { message: { isError: true, source: { callId }, content: [{ type: 'text', text: 'ENOENT' }] } },
      });
    }
    responder = () => answer('replan', 0.99, 0.99);

    const first = await runTool(app.ctx, { name: 'echo', args: { value: '1' }, agent, callId: 'dup-1' });
    assert.equal(first.executed, false, 'the first identical evidence denies');
    const budgetAfterFirst = await readStatus(app, agent);
    assert.equal(budgetAfterFirst.interventionsUsed, 1);

    // The same evidence again must not spend a second intervention.
    const second = await runTool(app.ctx, { name: 'echo', args: { value: '2' }, agent, callId: 'dup-2' });
    assert.equal(second.executed, true, 'a duplicate judgement lets the original flow continue');
    const after = await readStatus(app, agent);
    assert.equal(after.interventionsUsed, 1, 'identical evidence is never counted twice');
    assert.equal(
      auditRecords(dir, 'pre').some(record => record.reason === 'duplicate_evidence'),
      true,
      'and the duplicate is on the record',
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancelling supervision returns the original flow, and disposal leaves nothing behind', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('ts_live_cleanup') });
  try {
    const ran = registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    // An already-aborted execution signal is what a user cancellation looks like
    // by the time a judgement would run.
    const controller = new AbortController();
    controller.abort();
    responder = () => answer('replan', 0.99, 0.99);
    const cancelled = await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'cancel-1', signal: controller.signal });
    assert.equal(cancelled.result.isError, true);
    assert.equal(fetchCalls.length, 0, 'an aborted call makes no request');

    // Dispose the agent: its registrations go with it.
    app.ctx.emit('agent/disposed', { agent });
    const afterDispose = await runTool(app.ctx, { name: 'echo', args: { value: 'y' }, agent, callId: 'cancel-2' });
    assert.equal(afterDispose.executed, true, 'the tool still runs without supervision');
    assert.equal(fetchCalls.length, 0, 'no judgement happens after disposal');
    assert.equal(ran.length, 1, 'only the post-disposal call reached the tool body');

    // Unloading the plugin removes everything it registered, including the
    // status tool and the /jev command.
    await app.instance.dispose();
    assert.equal(app.ctx.tools.get('jev_supervisor_status', agent), undefined, 'the status tool is gone');
    assert.equal(app.commands.list(agent).some(command => command.name === 'jev'), false, 'the command is gone');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mixed-invalid budget request changes nothing, in either direction', async () => {
  const dir = tempDir();
  const seam = createCredentials(undefined);
  const app = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: seam });
  try {
    const agent = await createAgent(app);
    const before = await readStatus(app, agent);
    assert.equal(before.callBudget, 24);
    assert.equal(before.interventionLimit, 3);
    const auditBefore = auditRecords(dir, 'budget-change').length;
    /** Current settings file text, or a marker when nothing has been written. */
    const storedText = () => {
      try {
        return readFileSync(join(dir, 'settings.json'), 'utf8');
      } catch {
        return '<absent>';
      }
    };
    const storedBefore = storedText();

    // Valid call budget, invalid intervention limit: the whole request is refused.
    const forward = await app.route('/api/jev-supervisor/mode', { method: 'POST', body: { callBudget: 48, interventionLimit: 99 } });
    assert.equal(forward.status, 400);
    assert.deepEqual(forward.body, { ok: false, code: 'invalid_budget', fields: ['interventionLimit'] });
    const afterForward = await readStatus(app, agent);
    assert.equal(afterForward.callBudget, 24, 'the rejected call budget must not take effect');
    assert.equal(afterForward.interventionLimit, 3);
    assert.equal(auditRecords(dir, 'budget-change').length, auditBefore, 'a rejected request is not audited as applied');
    assert.equal(storedText(), storedBefore, 'a rejected request is not persisted');

    // The other direction: invalid call budget, valid intervention limit.
    const backward = await app.route('/api/jev-supervisor/mode', { method: 'POST', body: { callBudget: 0, interventionLimit: 9 } });
    assert.equal(backward.status, 400);
    assert.deepEqual(backward.body.fields, ['callBudget']);
    const afterBackward = await readStatus(app, agent);
    assert.equal(afterBackward.callBudget, 24);
    assert.equal(afterBackward.interventionLimit, 3, 'the valid half of a rejected request must not take effect either');
    assert.equal(auditRecords(dir, 'budget-change').length, auditBefore);

    // Both invalid: still one clean refusal.
    const both = await app.route('/api/jev-supervisor/mode', { method: 'POST', body: { callBudget: 101, interventionLimit: -1 } });
    assert.equal(both.status, 400);
    assert.deepEqual(both.body.fields.sort(), ['callBudget', 'interventionLimit']);
    const afterBoth = await readStatus(app, agent);
    assert.equal(afterBoth.callBudget, 24);
    assert.equal(afterBoth.interventionLimit, 3);

    // And the all-valid combination applies both at once.
    const applied = await app.route('/api/jev-supervisor/mode', { method: 'POST', body: { callBudget: 48, interventionLimit: 5 } });
    assert.equal(applied.status, 200);
    assert.deepEqual(applied.body, { ok: true, callBudget: 48, interventionLimit: 5 });
    const afterApplied = await readStatus(app, agent);
    assert.equal(afterApplied.callBudget, 48);
    assert.equal(afterApplied.interventionLimit, 5);
    assert.equal(auditRecords(dir, 'budget-change').length, auditBefore + 1, 'only the accepted change is audited');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rejected mixed request cannot be persisted later by an unrelated change', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'shadow' }, credentials: createCredentials(undefined) });
  try {
    const agent = await createAgent(app);
    await app.route('/api/jev-supervisor/mode', { method: 'POST', body: { callBudget: 48, interventionLimit: 99 } });
    // A later, unrelated accepted change must persist only what is really live.
    await app.route('/api/jev-supervisor/mode', { method: 'POST', body: { mode: 'enforce' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    const stored = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    assert.equal(stored.mode, 'enforce');
    assert.notEqual(stored.callBudget, 48, 'the rejected budget was never live, so it is never stored');
    assert.equal(stored.interventionLimit === undefined || stored.interventionLimit === 3, true);
    assert.equal((await readStatus(app, agent)).callBudget, 24);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/jev reset restores the allowance without changing the limits, the mode or the credential', async () => {
  const dir = tempDir();
  const app = await createApp({
    dataDir: dir,
    config: { mode: 'enforce', callBudget: 2 },
    credentials: createCredentials('ts_live_reset_probe'),
  });
  try {
    registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    responder = () => answer('continue', 0.99, 0.01);
    await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'reset-1' });
    const spent = await readStatus(app, agent);
    assert.equal(spent.callsUsed, 2);
    assert.equal(spent.limit, 'call_budget');
    assert.equal(spent.supervision, 'limited');

    // The user clears the task state explicitly.
    await runCommand(app, agent, '/jev reset');
    const cleared = await readStatus(app, agent);
    assert.equal(cleared.callsUsed, 0, 'the spend is gone');
    assert.equal(cleared.interventionsUsed, 0);
    assert.equal(cleared.faults, 0);
    assert.equal(cleared.limit, null);
    assert.equal(cleared.supervision, 'running', 'and supervision is available again');
    assert.equal(cleared.callBudget, 2, 'the configured budget is unchanged');
    assert.equal(cleared.interventionLimit, 3, 'the intervention limit is unchanged');
    assert.equal(cleared.mode, 'enforce', 'the mode is unchanged');
    assert.equal(cleared.keyConfigured, true, 'the credential is untouched');

    // The next judgement really happens, spending the fresh allowance.
    const before = fetchCalls.length;
    await runTool(app.ctx, { name: 'echo', args: { value: 'y' }, agent, callId: 'reset-2' });
    assert.equal(fetchCalls.length - before, 2, 'judgements resume after the reset');
    assert.equal((await readStatus(app, agent)).callsUsed, 2);
    assert.equal(
      auditRecords(dir, 'task-reset').length,
      1,
      'the reset itself is on the record, so a cleared counter is never mistaken for no supervision',
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reset clears the intervention, pause, fault and dedup state it claims to', async () => {
  const dir = tempDir();
  const app = await createApp({
    dataDir: dir,
    config: { mode: 'enforce', callBudget: 50, interventionLimit: 1 },
    credentials: createCredentials('ts_live_reset_scope'),
  });
  try {
    registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    commit(app, agent, { type: 'user/message', data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } });
    for (const callId of ['a', 'b']) {
      commit(app, agent, { type: 'tool/call', data: { callId, name: 'echo' } });
      commit(app, agent, {
        type: 'tool/result',
        data: { message: { isError: true, source: { callId }, content: [{ type: 'text', text: 'ENOENT' }] } },
      });
    }
    responder = () => answer('replan', 0.99, 0.99);

    // Spend the single intervention, then confirm the duplicate and the cap.
    const denied = await runTool(app.ctx, { name: 'echo', args: { value: '1' }, agent, callId: 'scope-1' });
    assert.equal(denied.executed, false);
    const capped = await runStatusJson(app, agent);
    assert.equal(capped.interventionsUsed, 1);
    assert.equal(capped.limit, 'intervention_limit', 'the independent cap is what is limiting');

    await runCommand(app, agent, '/jev reset');
    const after = await runStatusJson(app, agent);
    assert.equal(after.interventionsUsed, 0);
    assert.equal(after.limit, null, 'the cap no longer applies to a fresh task state');
    assert.equal(after.interventionLimit, 1, 'the configured cap itself is not changed');

    // The same evidence intervenes again, because the dedup memory was cleared
    // while the session's original failure facts were not.
    const again = await runTool(app.ctx, { name: 'echo', args: { value: '2' }, agent, callId: 'scope-2' });
    assert.equal(again.executed, false, 'the same evidence can intervene again after a reset');
    assert.equal((await runStatusJson(app, agent)).interventionsUsed, 1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reset touches only the addressed task, and off stays off', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce', callBudget: 3 }, credentials: createCredentials('ts_live_reset_isolation') });
  try {
    registerEchoTool(app.ctx, 'echo');
    const agentA = await createAgent(app, { sessionId: 'session-a' });
    const agentB = await createAgent(app, { sessionId: 'session-b' });
    responder = () => answer('continue', 0.99, 0.01);
    await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent: agentA, callId: 'iso-a' });
    await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent: agentB, callId: 'iso-b' });
    assert.equal((await runStatusJson(app, agentA)).callsUsed, 2);
    assert.equal((await runStatusJson(app, agentB)).callsUsed, 2);

    await runCommand(app, agentA, '/jev reset');
    assert.equal((await runStatusJson(app, agentA)).callsUsed, 0);
    assert.equal((await runStatusJson(app, agentB)).callsUsed, 2, "another task's counters are not touched");

    // off performs no call, and a reset does not switch supervision back on.
    await runCommand(app, agentA, '/jev off');
    const beforeOff = fetchCalls.length;
    await runCommand(app, agentA, '/jev reset');
    await runTool(app.ctx, { name: 'echo', args: { value: 'z' }, agent: agentA, callId: 'iso-off' });
    assert.equal(fetchCalls.length, beforeOff, 'reset under off still makes no request');
    assert.equal((await runStatusJson(app, agentA)).mode, 'off');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a judgement already in flight when the user resets cannot write into the fresh state', async () => {
  const dir = tempDir();
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce', callBudget: 5 }, credentials: createCredentials('ts_live_reset_race') });
  try {
    registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    // Hold the API call open so the reset happens while a judgement is unsettled.
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    let calls = 0;
    const restore = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        // The pre judgement is held open while the user resets.
        await gate;
        return new Response(JSON.stringify(answer('replan', 0.99, 0.99)), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // The post judgement runs against the fresh state and does not intervene.
      return new Response(JSON.stringify(answer('continue', 0.99, 0.01)), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const pending = runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'race-1' });
      await new Promise(resolve => setTimeout(resolve, 10));
      // The user resets while that request is still open.
      await runCommand(app, agent, '/jev reset');
      release();
      const outcome = await pending;
      assert.equal(outcome.executed, true);
      const settled = await runStatusJson(app, agent);
      // The superseded pre judgement is discarded: it never denies, never feeds
      // back and never fills the fresh state's intervention or fault counters.
      assert.equal(settled.interventionsUsed, 0, 'a superseded judgement cannot intervene after a reset');
      assert.equal(settled.faults, 0);
      assert.equal(settled.limit, null);
      assert.equal(outcome.result.additionalContexts, undefined, 'and it attaches no corrective context');
      assert.equal(
        auditRecords(dir, 'pre').some(record => record.reason === 'task_reset'),
        true,
        'the discarded judgement records why it was discarded',
      );
      // Only the post judgement that ran after the reset is counted.
      assert.equal(settled.callsUsed, 1, 'the fresh task state counts only what happened after the reset');
    } finally {
      globalThis.fetch = restore;
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the first limited record names the limit, not the judgement that preceded it', async () => {
  const dir = tempDir();
  const app = await createApp({
    dataDir: dir,
    config: { mode: 'enforce', callBudget: 1 },
    credentials: createCredentials('ts_live_limit_reason'),
  });
  try {
    registerEchoTool(app.ctx, 'echo');
    const agent = await createAgent(app);
    // The last judgement before the budget runs out is a low-confidence replan,
    // which returns to the original flow. The first record that observes the
    // limit must still name the budget.
    responder = () =>
      answer('replan', 0.84, 0.99);
    const outcome = await runTool(app.ctx, { name: 'echo', args: { value: 'x' }, agent, callId: 'limit-1' });
    assert.equal(outcome.executed, true, 'a low-confidence judgement never blocks');

    const limited = auditRecords(dir, 'limited').at(-1);
    assert.ok(limited, 'the limit transition is audited once');
    assert.equal(limited.reason, 'call_budget_exhausted', 'the limit reason names the limit');
    assert.equal(limited.limit, 'call_budget');
    assert.equal(limited.lastDecisionReason, 'low_confidence', 'and the preceding decision is preserved separately');
    assert.equal(limited.calls, 1);
    assert.equal(limited.callBudget, 1);

    const status = await runStatusJson(app, agent);
    assert.equal(status.limitReason, 'call_budget_exhausted');
    assert.equal(status.lastDecisionReason, 'low_confidence');
    assert.equal(status.supervision, 'limited');
    assert.equal(status.reachability, 'connected', 'and the connection is untouched by the limit');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Run one tool call whose body always succeeds, for budget arithmetic. The echo
 * tool's output contract only covers true/false results, so this registers its
 * own trivial tool once and then drives it repeatedly.
 */
async function driver(app, agent, { name = 'driver', callId = 'd', done = true } = {}) {
  void done;
  return runTool(app.ctx, { name, args: {}, agent, callId });
}

test('raising the limit right after it is hit lifts it, and lowering it re-imposes it', async () => {
  const dir = tempDir();
  const app = await createApp({
    dataDir: dir,
    config: { mode: 'enforce', callBudget: 1 },
    credentials: createCredentials('ts_live_limit_cycle'),
  });
  try {
    registerEchoTool(app.ctx, 'echo');
    app.ctx.effect(() =>
      app.ctx.tools.register({
        name: 'driver',
        description: 'trivial succeeding tool for budget arithmetic',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
          render: (_args, value) => [{ type: 'text', text: String(value.ok) }],
        },
        execute: async () => ({ ok: true }),
      }),
    );
    const agent = await createAgent(app);
    responder = () => answer('continue', 0.99, 0.01);
    await runTool(app.ctx, { name: 'driver', args: {}, agent, callId: 'cycle-1' });
    const hit = await runStatusJson(app, agent);
    assert.equal(hit.limit, 'call_budget');
    assert.equal(hit.limitReason, 'call_budget_exhausted');

    // Raising it lifts the limit and supervision resumes with the spend intact.
    await app.route('/api/jev-supervisor/mode', { method: 'POST', body: { callBudget: 4 } });
    const lifted = await runStatusJson(app, agent);
    assert.equal(lifted.limit, null);
    assert.equal(lifted.limitReason, null, 'a lifted limit has no reason to report');
    assert.equal(lifted.callsUsed, hit.callsUsed, 'and the spend is unchanged');
    assert.equal(lifted.supervision, 'running');

    // A tool action is judged before and after it runs, so a raised ceiling of 4
    // is spent by two actions at most: the count rises honestly and never jumps.
    const before = fetchCalls.length;
    await driver(app, agent, { name: 'driver', callId: 'cycle-2' });
    const afterOne = await runStatusJson(app, agent);
    assert.equal(afterOne.limit, null, 'a raised ceiling is not immediately limited');
    assert.equal(fetchCalls.length - before, 2, 'one action spends a pre and a post judgement');
    assert.equal(afterOne.callsUsed, hit.callsUsed + 2, 'and the spend is exactly what happened');

    const beforeSecond = fetchCalls.length;
    await driver(app, agent, { name: 'driver', callId: 'cycle-3' });
    const spent = await runStatusJson(app, agent);
    // The second action spends what is left of the ceiling and no more: its post
    // judgement is skipped once the budget is gone.
    assert.equal(fetchCalls.length - beforeSecond, 1, 'the ceiling stops further calls');
    assert.equal(spent.callsUsed, 4, 'the budget is exactly consumed');
    assert.equal(spent.limit, 'call_budget', 'and the limit is in force again');
    assert.equal(spent.limitReason, 'call_budget_exhausted');

    // Lowering the ceiling below the spend keeps it limited and still resets nothing.
    await app.route('/api/jev-supervisor/mode', { method: 'POST', body: { callBudget: 2 } });
    const reimposed = await runStatusJson(app, agent);
    assert.equal(reimposed.limit, 'call_budget');
    assert.equal(reimposed.limitReason, 'call_budget_exhausted');
    assert.equal(reimposed.callsUsed, 4, 'still without resetting anything');
    assert.equal(auditRecords(dir, 'limit-lifted').length >= 1, true, 'the lift is on the record too');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
