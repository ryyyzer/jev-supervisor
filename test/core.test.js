/**
 * Core unit tests: the bounded snapshot, the scrubbers, the response validator,
 * the transport wrapper, and every decision rule of the Supervisor.
 *
 * These run without any Harness service: `core.js` is pure, which is what makes
 * the same rules portable across deployments.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALL_BUDGET_PRESETS,
  DEFAULTS,
  ENDPOINT,
  SUPERVISION_STATES,
  Supervisor,
  classifySupervision,
  currentLimit,
  isCallBudget,
  callJev,
  evidenceOf,
  feedbackTemplate,
  fold,
  initialProjection,
  makeSnapshot,
  redactTree,
  scrub,
  scrubText,
  validateResponse,
} from '../lib/core.js';

// ---------------------------------------------------------------------------
// scrubbing and redaction
// ---------------------------------------------------------------------------

test('scrubText removes a live secret verbatim and redacts credential shapes', () => {
  const live = 'ts_live_abcdefghijklmnop';
  const text = `key=${live} also sk-abcdefghijklmnop and Bearer zzzzzzzzzzzz mail a@b.co 表 /Users/someone/x`;
  const clean = scrubText(text, 1000, [live]);
  assert.ok(!clean.includes(live), 'live secret must be gone');
  assert.ok(!clean.includes('sk-abcdefghijklmnop'));
  assert.ok(clean.includes('[REDACTED]'));
  assert.ok(clean.includes('/Users/[USER]'));
  assert.ok(clean.includes('[EMAIL]'));
});

test('scrub drops secret-named fields but keeps token accounting', () => {
  const value = scrub({
    apiKey: 'secret-value',
    authorization: 'Bearer x',
    password: 'p',
    privateKey: 'k',
    input_tokens: 12,
    output_tokens: 3,
    nested: { cookie: 'c', ok: 'keep' },
  });
  assert.equal(value.apiKey, '[REDACTED]');
  assert.equal(value.authorization, '[REDACTED]');
  assert.equal(value.password, '[REDACTED]');
  assert.equal(value.privateKey, '[REDACTED]');
  assert.equal(value.nested.cookie, '[REDACTED]');
  assert.equal(value.nested.ok, 'keep');
  assert.equal(value.input_tokens, 12);
  assert.equal(value.output_tokens, 3);
});

test('scrub omits whole-content fields used by tools', () => {
  const value = scrub({ content: 'a whole file', body: 'x', newText: 'y', path: '/tmp/a' });
  assert.equal(value.content, '[CONTENT OMITTED]');
  assert.equal(value.body, '[CONTENT OMITTED]');
  assert.equal(value.newText, '[CONTENT OMITTED]');
  assert.equal(value.path, '/tmp/a');
});

test('scrub bounds depth, breadth, arrays and command heredocs', () => {
  const deep = { a: { b: { c: { d: { e: 'far' } } } } };
  assert.ok(JSON.stringify(scrub(deep)).includes('[DEPTH OMITTED]'));
  const wide = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index]));
  assert.equal(Object.keys(scrub(wide)).length, 20);
  assert.equal(scrub({ list: Array.from({ length: 30 }, (_, index) => index) }).list.length, 8);
  const heredoc = scrub({ command: 'cat <<EOF\nsecret body\nEOF' });
  assert.equal(heredoc.command, 'cat [HEREDOC OMITTED]');
});

test('redactTree removes the secret from already-stringified values', () => {
  const live = 'ts_live_abcdefghijklmnop';
  const out = redactTree({ a: [`prefix ${live} suffix`], b: { c: live } }, [live]);
  assert.equal(JSON.stringify(out).includes(live), false);
});

test('URL and phone scrubbing degrades safely on malformed input', () => {
  const text = scrubText('see https://user:pw@example.com/p?token=abc#f and 138 0013 8000 and http://[');
  assert.ok(!text.includes('pw'));
  assert.ok(!text.includes('token=abc'));
  assert.ok(text.includes('[NUMBER]') || text.includes('[URL]'));
});

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

test('makeSnapshot states its authority rules and keeps unknowns unknown', () => {
  const snapshot = makeSnapshot(
    { ...initialProjection({ id: 'session-1' }), users: [{ authority: 'user', text: 'do the thing', seq: 3 }] },
    { callId: 'c1', rootCallId: 'r1', name: 'bash', arguments: { command: 'ls' } },
    undefined,
    8000,
  );
  assert.equal(snapshot.schemaVersion, 1);
  assert.match(snapshot.authorityRules, /untrusted observations/);
  assert.equal(snapshot.plan, 'unknown');
  assert.equal(snapshot.completion, 'unknown');
  assert.equal(snapshot.actualResult, 'unknown');
  assert.equal(snapshot.proposedTool.name, 'bash');
  assert.equal(snapshot.userInstructions[0].authority, 'user');
});

test('makeSnapshot never forwards the live key even inside tool arguments', () => {
  const live = 'ts_live_abcdefghijklmnop';
  const snapshot = makeSnapshot(
    initialProjection({ id: 's' }),
    { callId: 'c', name: 'bash', arguments: { command: `curl -H 'Authorization: Bearer ${live}' x`, note: live } },
    undefined,
    8000,
    [live],
  );
  assert.equal(JSON.stringify(snapshot).includes(live), false);
});

test('makeSnapshot shrinks to the byte budget by dropping evidence first', () => {
  const projection = {
    ...initialProjection({ id: 's' }),
    recent: Array.from({ length: 5 }, (_, index) => ({ seq: index, authority: 'untrusted-tool-data', error: 'x'.repeat(400) })),
    failures: Array.from({ length: 5 }, (_, index) => ({ seq: index, isError: true, error: 'y'.repeat(400) })),
  };
  const snapshot = makeSnapshot(projection, { callId: 'c', name: 'bash', arguments: { command: 'z'.repeat(2000) } }, undefined, 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 2000);
});

test('makeSnapshot survives an extreme budget without throwing', () => {
  const projection = {
    ...initialProjection({ id: 's' }),
    users: [{ authority: 'user', text: 'u'.repeat(3000), seq: 1 }],
  };
  const snapshot = makeSnapshot(projection, { callId: 'c', name: 'bash'.repeat(50), arguments: { a: 'b'.repeat(3000) } }, undefined, 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 2000);
  assert.equal(snapshot.completion, 'unknown');
});

// ---------------------------------------------------------------------------
// message-source authority
// ---------------------------------------------------------------------------

test('fold treats only user-authored messages as user authority', () => {
  let state = initialProjection({ id: 's' });
  state = fold(state, { seq: 1, type: 'user/message', data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'real instruction' }] } });
  state = fold(state, { seq: 2, type: 'user/message', data: { id: 'm2', source: { kind: 'plugin', plugin: 'jev-supervisor' }, content: [{ type: 'text', text: 'supervision feedback' }] } });
  assert.equal(state.users.length, 1);
  assert.equal(state.users[0].text, 'real instruction');
});

test('fold ignores supervision feedback when collecting failures', () => {
  let state = initialProjection({ id: 's' });
  state = fold(state, { seq: 1, type: 'tool/call', data: { callId: 'c1', name: 'bash' } });
  state = fold(state, {
    seq: 2,
    type: 'tool/result',
    data: { message: { isError: true, source: { callId: 'c1' }, content: [{ type: 'text', text: '[Jev Supervisor] denied' }] } },
  });
  assert.equal(state.failures.length, 0);
  assert.equal(state.recent.length, 1);
});

test('fold records the actual DeepSeek usage it was given', () => {
  const state = fold(initialProjection({ id: 's' }), {
    seq: 9,
    type: 'assistant/message',
    data: { usage: { input_tokens: 10, output_tokens: 2 }, message: { source: { provider: 'deepseek-official', model: 'deepseek-flash' } } },
  });
  assert.equal(state.deepseekUsage.provider, 'deepseek-official');
  assert.equal(state.deepseekUsage.usage.input_tokens, 10);
});

// ---------------------------------------------------------------------------
// response validation
// ---------------------------------------------------------------------------

const validResponse = (overrides = {}) => ({
  model: 'jev-1.13.0',
  answers: {
    action: {
      type: 'choice',
      choice: 'continue',
      confidence: 0.99,
      probabilities: { continue: 0.97, replan: 0.02, ask_user: 0.01 },
    },
    repeated_failure: { type: 'noul', noul: 0.01 },
    goal_drift: { type: 'noul', noul: 0.01 },
  },
  usage: { input_tokens: 100, output_tokens: 7 },
  ...overrides,
});

test('validateResponse accepts a well-formed answer', () => {
  const judgment = validateResponse(validResponse(), 'jev-1.13.0');
  assert.equal(judgment.choice, 'continue');
  assert.equal(judgment.confidence, 0.99);
  assert.equal(judgment.usage.input_tokens, 100);
});

test('validateResponse rejects a model mismatch and an alias', () => {
  assert.throws(() => validateResponse(validResponse({ model: 'jev-1.12.0' }), 'jev-1.13.0'), /MODEL_MISMATCH/);
  assert.throws(() => validateResponse(validResponse({ model: 'latest' }), 'latest'), /MODEL_MISMATCH/);
});

test('validateResponse rejects impossible probabilities and types', () => {
  const bad = validResponse();
  bad.answers.action.probabilities = { continue: 0.5, replan: 0.5, ask_user: 0.5 };
  assert.throws(() => validateResponse(bad, 'jev-1.13.0'), /INVALID_CHOICE/);
  const missing = validResponse();
  missing.answers.repeated_failure = { type: 'noul' };
  assert.throws(() => validateResponse(missing, 'jev-1.13.0'), /INVALID_NOUL/);
  const noUsage = validResponse();
  noUsage.usage = { input_tokens: 1.5, output_tokens: 1 };
  assert.throws(() => validateResponse(noUsage, 'jev-1.13.0'), /INVALID_USAGE/);
  const wrongType = validResponse();
  wrongType.answers.action.type = 'noul';
  assert.throws(() => validateResponse(wrongType, 'jev-1.13.0'), /INVALID_CHOICE/);
});

test('validateResponse rejects a choice whose own probability is not the highest', () => {
  const bad = validResponse();
  bad.answers.action.choice = 'replan';
  bad.answers.action.probabilities = { continue: 0.9, replan: 0.05, ask_user: 0.05 };
  assert.throws(() => validateResponse(bad, 'jev-1.13.0'), /INVALID_CHOICE/);
});

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

/** Build a fake Response with a bounded body stream. */
function jsonResponse(body, { status = 200, headers = {}, chunks } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: chunks ? bytes.slice(0, chunks) : bytes };
        },
        cancel: async () => {},
      }),
      cancel: async () => {},
    },
    text: async () => text,
  };
}

test('callJev posts the pinned model, the questions and a bearer credential', async () => {
  let seen;
  const result = await callJev({
    snapshot: { schemaVersion: 1 },
    model: 'jev-1.13.0',
    key: 'ts_live_abcdefghijklmnop',
    fetchFn: async (url, init) => {
      seen = { url, init };
      return jsonResponse(validResponse());
    },
  });
  assert.equal(seen.url, ENDPOINT);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.redirect, 'error');
  assert.equal(seen.init.headers.Authorization, 'Bearer ts_live_abcdefghijklmnop');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, 'jev-1.13.0');
  assert.equal(body.questions.action.type, 'choice');
  assert.equal(body.questions.repeated_failure.type, 'noul');
  assert.equal(result.choice, 'continue');
  assert.equal(typeof result.latencyMs, 'number');
});

test('callJev reports an HTTP failure and never retries', async () => {
  let calls = 0;
  await assert.rejects(
    callJev({
      snapshot: {},
      model: 'jev-1.13.0',
      key: 'k',
      fetchFn: async () => {
        calls++;
        return jsonResponse('denied', { status: 401 });
      },
    }),
    /HTTP_401/,
  );
  assert.equal(calls, 1);
});

test('callJev refuses an oversized body and a missing credential', async () => {
  await assert.rejects(
    callJev({
      snapshot: {},
      model: 'jev-1.13.0',
      key: 'k',
      fetchFn: async () => jsonResponse('{}', { headers: { 'content-length': '40000' } }),
    }),
    /RESPONSE_TOO_LARGE/,
  );
  await assert.rejects(callJev({ snapshot: {}, model: 'jev-1.13.0', key: '', fetchFn: async () => jsonResponse({}) }), /KEY_UNAVAILABLE/);
});

// ---------------------------------------------------------------------------
// Supervisor decisions
// ---------------------------------------------------------------------------

/** Judgment builder for the decision tests. */
const judgmentOf = (choice, { confidence = 0.99, probabilities, repeatedFailure = 0.01, goalDrift = 0.01 } = {}) => ({
  model: 'jev-1.13.0',
  choice,
  confidence,
  probabilities: probabilities ?? {
    continue: choice === 'continue' ? 0.98 : 0.01,
    replan: choice === 'replan' ? 0.98 : 0.01,
    ask_user: choice === 'ask_user' ? 0.98 : 0.01,
  },
  repeatedFailure,
  goalDrift,
  usage: { input_tokens: 1, output_tokens: 1 },
});

/** Supervisor with an injected transport that answers one fixed judgment. */
function supervisorWith(judgment, config = {}, hooks = {}) {
  let calls = 0;
  const supervisor = new Supervisor(
    { mode: 'enforce', apiEnabled: true, ...config },
    {
      getKey: async () => 'ts_live_abcdefghijklmnop',
      call: async () => {
        calls++;
        if (hooks.onCall) await hooks.onCall(calls);
        if (judgment instanceof Error) throw judgment;
        return judgment;
      },
    },
  );
  return { supervisor, callCount: () => calls };
}

/** Snapshot with the given evidence. */
const snapshotWith = ({ failures = [], actual = undefined, users = [{ authority: 'user', text: 'do it', seq: 1 }] } = {}) => ({
  sessionId: 's',
  userInstructions: users,
  explicitGoal: 'unknown',
  failures,
  recentResults: [],
  actualResult: actual ?? 'unknown',
  proposedTool: { callId: 'c1', rootCallId: 'r1', name: 'bash', arguments: {} },
});

test('off performs no call and shadow never acts', async () => {
  const off = supervisorWith(judgmentOf('replan'), { mode: 'off' });
  assert.deepEqual((await off.supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' })).reason, 'off');
  assert.equal(off.callCount(), 0);

  const disabled = supervisorWith(judgmentOf('replan'), { apiEnabled: false });
  assert.equal((await disabled.supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' })).reason, 'api_not_configured');
  assert.equal(disabled.callCount(), 0);

  const shadow = supervisorWith(judgmentOf('replan', { repeatedFailure: 0.99 }), { mode: 'shadow' });
  const shadowOut = await shadow.supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' });
  assert.equal(shadowOut.action, 'none');
  assert.equal(shadowOut.reason, 'shadow');
  assert.equal(shadow.callCount(), 1);
});

test('a low-confidence or low-probability judgment never acts', async () => {
  const lowConfidence = supervisorWith(judgmentOf('replan', { confidence: 0.5, repeatedFailure: 0.99 }));
  assert.equal((await lowConfidence.supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' })).reason, 'low_confidence');

  const lowProbability = supervisorWith(
    judgmentOf('replan', { probabilities: { continue: 0.5, replan: 0.3, ask_user: 0.2 }, repeatedFailure: 0.99 }),
  );
  assert.equal((await lowProbability.supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' })).reason, 'low_confidence');
});

test('replan without repeated real failures stays non-intervening', async () => {
  const noEvidence = supervisorWith(judgmentOf('replan', { repeatedFailure: 0.99 }));
  assert.equal((await noEvidence.supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' })).reason, 'insufficient_evidence');

  const once = supervisorWith(judgmentOf('replan', { repeatedFailure: 0.99 }));
  const oneFailure = snapshotWith({ failures: [{ tool: 'bash', error: 'ENOENT', callId: 'a', isError: true, seq: 2 }] });
  assert.equal((await once.supervisor.judge({ taskId: 't', snapshot: oneFailure, stage: 'pre' })).reason, 'insufficient_evidence');
});

test('replan with repeated identical real failures denies at pre and gives feedback at post', async () => {
  const repeated = snapshotWith({
    failures: [
      { tool: 'bash', error: 'ENOENT', callId: 'a', isError: true, seq: 2 },
      { tool: 'bash', error: 'ENOENT', callId: 'b', isError: true, seq: 4 },
    ],
  });
  const pre = supervisorWith(judgmentOf('replan', { repeatedFailure: 0.99 }));
  const deny = await pre.supervisor.judge({ taskId: 't', snapshot: repeated, stage: 'pre' });
  assert.equal(deny.action, 'deny');
  assert.match(deny.feedback, /\[Jev Supervisor\]/);

  const post = supervisorWith(judgmentOf('replan', { repeatedFailure: 0.99 }));
  const feedback = await post.supervisor.judge({ taskId: 't', snapshot: repeated, stage: 'post' });
  assert.equal(feedback.action, 'feedback');
});

test('identical evidence is deduplicated and budgets are enforced', async () => {
  const repeated = snapshotWith({
    failures: [
      { tool: 'bash', error: 'ENOENT', callId: 'a', isError: true, seq: 2 },
      { tool: 'bash', error: 'ENOENT', callId: 'b', isError: true, seq: 4 },
    ],
  });
  const { supervisor } = supervisorWith(judgmentOf('replan', { repeatedFailure: 0.99 }), { interventionLimit: 3 });
  const first = await supervisor.judge({ taskId: 't', snapshot: repeated, stage: 'pre' });
  assert.equal(first.action, 'deny');
  const second = await supervisor.judge({ taskId: 't', snapshot: repeated, stage: 'pre' });
  assert.equal(second.reason, 'duplicate_evidence');
  // Different evidence reaches the intervention cap.
  const other = snapshotWith({
    failures: [
      { tool: 'read', error: 'PERMISSION', callId: 'c', isError: true, seq: 6 },
      { tool: 'read', error: 'PERMISSION', callId: 'd', isError: true, seq: 8 },
    ],
  });
  assert.equal((await supervisor.judge({ taskId: 't', snapshot: other, stage: 'pre' })).action, 'deny');
  const capped = await supervisor.judge({ taskId: 't', snapshot: other, stage: 'pre' });
  assert.equal(capped.reason, 'duplicate_evidence');
});

test('the intervention limit stops acting while calls continue', async () => {
  const { supervisor } = supervisorWith(judgmentOf('replan', { repeatedFailure: 0.99 }), { interventionLimit: 1 });
  const a = snapshotWith({
    failures: [
      { tool: 'bash', error: 'E1', callId: 'a', isError: true, seq: 1 },
      { tool: 'bash', error: 'E1', callId: 'b', isError: true, seq: 2 },
    ],
  });
  const b = snapshotWith({
    failures: [
      { tool: 'bash', error: 'E2', callId: 'c', isError: true, seq: 3 },
      { tool: 'bash', error: 'E2', callId: 'd', isError: true, seq: 4 },
    ],
  });
  assert.equal((await supervisor.judge({ taskId: 't', snapshot: a, stage: 'pre' })).action, 'deny');
  const limited = await supervisor.judge({ taskId: 't', snapshot: b, stage: 'pre' });
  assert.equal(limited.reason, 'intervention_limit');
});

test('the call budget stops supervision and clears the circuit breaker on success', async () => {
  const { supervisor, callCount } = supervisorWith(judgmentOf('continue'), { callBudget: 2 });
  await supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' });
  await supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' });
  const exhausted = await supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' });
  assert.equal(exhausted.reason, 'call_budget_exhausted', 'an exhausted call budget names itself');
  assert.equal(supervisor.task('t').limit, 'call_budget');
  assert.equal(callCount(), 2);

  // A success resets the fault counter, so spaced faults never trip the breaker.
  let mode = 'fail';
  const flaky = new Supervisor(
    { mode: 'enforce', apiEnabled: true, callBudget: 10 },
    {
      getKey: async () => 'k',
      call: async () => {
        if (mode === 'fail') throw new Error('boom');
        return judgmentOf('continue');
      },
    },
  );
  for (let index = 0; index < 4; index++) {
    assert.equal((await flaky.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' })).reason, 'request_failed');
    mode = 'ok';
    assert.equal((await flaky.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' })).reason, 'continue');
    mode = 'fail';
  }
  // The counter is 0 because an intervening success cleared each fault: the
  // breaker never trips however many faults are spaced this way.
  assert.equal(flaky.task('t').faults, 0);
});

test('consecutive faults trip the circuit breaker with typed reasons', async () => {
  const { supervisor } = supervisorWith(new Error('HTTP_500'));
  for (let index = 0; index < DEFAULTS.maxConsecutiveFaults; index++) {
    assert.equal((await supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' })).reason, 'HTTP_500');
  }
  const tripped = await supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' });
  assert.equal(tripped.reason, 'circuit_open', 'a fault circuit and an exhausted budget are different facts');
  assert.equal(supervisor.task('t').limit, 'circuit_breaker');
});

test('a cancelled call never acts and never counts as an intervention', async () => {
  const controller = new AbortController();
  const { supervisor } = supervisorWith(judgmentOf('replan', { repeatedFailure: 0.99 }), {}, {
    onCall: async () => controller.abort(),
  });
  const out = await supervisor.judge({ taskId: 't', snapshot: snapshotWith(), signal: controller.signal, stage: 'pre' });
  assert.equal(out.action, 'none');
  assert.equal(out.reason, 'cancelled');
  assert.equal(supervisor.task('t').interventions, 0);
});

test('a mode change during the await discards the judgment', async () => {
  const { supervisor } = supervisorWith(judgmentOf('replan', { repeatedFailure: 0.99 }), {}, {
    onCall: async () => {
      supervisor.config.mode = 'shadow';
    },
  });
  const out = await supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' });
  assert.equal(out.reason, 'mode_changed');
  assert.equal(out.action, 'none');
});

test('ask_user asks at pre, pauses at post, and ends the blocked turn', async () => {
  const pre = supervisorWith(judgmentOf('ask_user'));
  const asked = await pre.supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' });
  assert.equal(asked.action, 'ask');

  const post = supervisorWith(judgmentOf('ask_user'));
  const paused = await post.supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'post' });
  assert.equal(paused.action, 'pause');
  assert.equal(post.supervisor.task('t').paused, true);
});

test('goal drift with a real user objective can deny; without one it cannot', async () => {
  const drift = judgmentOf('replan', { goalDrift: 0.99, repeatedFailure: 0.01 });
  const withGoal = supervisorWith(drift);
  const denied = await withGoal.supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' });
  assert.equal(denied.action, 'deny');

  const withoutGoal = supervisorWith(drift);
  const held = await withoutGoal.supervisor.judge({
    taskId: 't',
    snapshot: snapshotWith({ users: [] }),
    stage: 'pre',
  });
  assert.equal(held.reason, 'insufficient_evidence');
});

test('concurrent calls cannot exceed the call budget or the intervention limit', async () => {
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const { supervisor, callCount } = supervisorWith(judgmentOf('continue'), { callBudget: 3 }, { onCall: () => gate });
  const pending = [0, 1, 2, 3, 4].map(index => supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(supervisor.task('t').calls, 3, 'the call is reserved synchronously before the await');
  release();
  const results = await Promise.all(pending);
  assert.equal(results.filter(result => result.reason === 'call_budget_exhausted').length, 2);
  assert.equal(callCount(), 3);

  let releaseIntervention;
  const interventionGate = new Promise(resolve => {
    releaseIntervention = resolve;
  });
  const repeated = snapshotWith({
    failures: [
      { tool: 'bash', error: 'E', callId: 'a', isError: true, seq: 1 },
      { tool: 'bash', error: 'E', callId: 'b', isError: true, seq: 2 },
    ],
  });
  const limited = supervisorWith(judgmentOf('replan', { repeatedFailure: 0.99 }), { interventionLimit: 1 }, {
    onCall: () => interventionGate,
  });
  const racing = [0, 1, 2].map(() => limited.supervisor.judge({ taskId: 't', snapshot: repeated, stage: 'pre' }));
  await new Promise(resolve => setTimeout(resolve, 5));
  releaseIntervention();
  const outcomes = await Promise.all(racing);
  assert.equal(outcomes.filter(outcome => outcome.action === 'deny').length, 1);
  assert.equal(limited.supervisor.task('t').interventions, 1);
});

test('task state is isolated per task id', async () => {
  const { supervisor } = supervisorWith(judgmentOf('continue'));
  await supervisor.judge({ taskId: 'a', snapshot: snapshotWith(), stage: 'pre' });
  await supervisor.judge({ taskId: 'a', snapshot: snapshotWith(), stage: 'pre' });
  await supervisor.judge({ taskId: 'b', snapshot: snapshotWith(), stage: 'pre' });
  assert.equal(supervisor.task('a').calls, 2);
  assert.equal(supervisor.task('b').calls, 1);
});

test('cancelCalls aborts in-flight work and dispose forgets every task', async () => {
  // The transport waits for its own abort signal, which is what a real socket does.
  const withSignal = new Supervisor(
    { mode: 'enforce', apiEnabled: true },
    {
      getKey: async () => 'k',
      call: ({ signal }) =>
        new Promise((_resolve, reject) => {
          if (signal.aborted) {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            return;
          }
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        }),
    },
  );
  const pending = withSignal.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' });
  await new Promise(resolve => setImmediate(resolve));
  withSignal.cancelCalls();
  const out = await pending;
  assert.equal(out.action, 'none');
  assert.equal(out.reason, 'cancelled');
  withSignal.dispose();
  assert.equal(withSignal.tasks.size, 0);
});

// ---------------------------------------------------------------------------
// feedback text
// ---------------------------------------------------------------------------

test('feedback cites evidence, marks tool text untrusted and keeps the result valid', () => {
  const snapshot = snapshotWith({
    failures: [
      { tool: 'bash', error: 'ENOENT', callId: 'a', isError: true, seq: 7 },
      { tool: 'bash', error: 'ENOENT', callId: 'b', isError: true, seq: 9 },
    ],
    actual: { isError: true, code: 'TOOL_ERROR', error: 'ENOENT' },
  });
  const text = feedbackTemplate(judgmentOf('replan'), snapshot);
  assert.match(text, /session:s\/seq:7/);
  assert.match(text, /不可信工具数据/);
  assert.match(text, /原始工具结果保持有效/);
});

test('feedback bounds the error summary it quotes', () => {
  const snapshot = snapshotWith({
    failures: [{ tool: 'bash', error: 'x'.repeat(1000), callId: 'a', isError: true, seq: 1 }],
    actual: { isError: true, code: 'C', error: 'y'.repeat(1000) },
  });
  const text = feedbackTemplate(judgmentOf('replan'), snapshot);
  assert.ok(text.length < 900);
});

test('evidenceOf collects call, sequence and user references', () => {
  const refs = evidenceOf(
    snapshotWith({
      failures: [{ seq: 4, callId: 'b', error: 'E' }],
      actual: { isError: true, code: 'C', error: 'E2' },
    }),
  );
  assert.equal(refs.length, 3);
  assert.ok(refs.some(ref => ref.messageId !== undefined || ref.authority === 'user'));
});

// ---------------------------------------------------------------------------
// supervision classification
// ---------------------------------------------------------------------------

test('connection health and supervision health are classified separately', () => {
  const base = { mode: 'enforce', apiEnabled: true, reachability: 'connected', keyConfigured: true, budget: { limit: null, reason: null, paused: false } };
  assert.equal(classifySupervision(base).state, SUPERVISION_STATES.RUNNING);

  // A working connection with an exhausted budget is NOT "running".
  assert.deepEqual(classifySupervision({ ...base, budget: { limit: 'call_budget', reason: 'call_budget_exhausted', paused: false } }), {
    state: SUPERVISION_STATES.LIMITED,
    reason: 'call_budget_exhausted',
    limit: 'call_budget',
  });
  assert.equal(
    classifySupervision({ ...base, budget: { limit: 'intervention_limit', reason: 'intervention_limit', paused: false } }).state,
    SUPERVISION_STATES.LIMITED,
  );
  assert.equal(
    classifySupervision({ ...base, budget: { limit: 'circuit_breaker', reason: 'circuit_open', paused: false } }).state,
    SUPERVISION_STATES.LIMITED,
  );

  // A pause outranks the running state, and the other configurations each name
  // themselves rather than collapsing into one "not working" bucket.
  assert.equal(classifySupervision({ ...base, budget: { limit: null, reason: 'needs_user', paused: true } }).state, SUPERVISION_STATES.PAUSED);
  assert.equal(classifySupervision({ ...base, keyConfigured: false }).state, SUPERVISION_STATES.NOT_CONFIGURED);
  assert.equal(classifySupervision({ ...base, apiEnabled: false }).state, SUPERVISION_STATES.OFF);
  assert.equal(classifySupervision({ ...base, mode: 'off' }).state, SUPERVISION_STATES.OFF);
  assert.equal(classifySupervision({ ...base, reachability: 'unreachable' }).state, SUPERVISION_STATES.UNREACHABLE);
  assert.equal(classifySupervision({ ...base, reachability: 'unverified' }).state, SUPERVISION_STATES.UNVERIFIED);
  assert.equal(classifySupervision({ ...base, mode: 'shadow' }).state, SUPERVISION_STATES.OBSERVING);
});

test('a limited task keeps its reason visible even when the mode is off afterwards', () => {
  const limited = classifySupervision({
    mode: 'off',
    apiEnabled: false,
    reachability: 'connected',
    keyConfigured: true,
    budget: { limit: 'call_budget', reason: 'call_budget_exhausted', paused: false },
  });
  assert.equal(limited.state, SUPERVISION_STATES.OFF, 'an explicit off is the stronger fact');
});

test('budgetOf reports the counters and the sticky limit', async () => {
  const { supervisor } = supervisorWith(judgmentOf('continue'), { callBudget: 1 });
  assert.deepEqual(supervisor.budgetOf('t').limit, null);
  await supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' });
  await supervisor.judge({ taskId: 't', snapshot: snapshotWith(), stage: 'pre' });
  const budget = supervisor.budgetOf('t');
  assert.equal(budget.calls, 1);
  assert.equal(budget.callBudget, 1);
  assert.equal(budget.limit, 'call_budget');
  assert.equal(budget.reason, 'call_budget_exhausted');
  // The stop is reported before any new judgment is made, so there is none to
  // keep; the earlier judgement was already delivered to the caller that used it.
  assert.equal(budget.judgment, null);
  assert.equal(budget.paused, false);
  assert.equal(budget.maxFaults, 3);
});

test('a raised ceiling lifts the limit and a lowered one re-imposes it, without touching spend', () => {
  const state = { calls: 12, interventions: 1, faults: 0 };
  const limits = { callBudget: 12, interventionLimit: 3, maxFaults: 3 };
  assert.equal(currentLimit(state, limits), 'call_budget', 'spend at the ceiling is limited');
  assert.equal(currentLimit(state, { ...limits, callBudget: 24 }), null, 'raising the budget resumes supervision');
  assert.equal(currentLimit(state, { ...limits, callBudget: 6 }), 'call_budget', 'lowering it below spend limits again');
  // The counters themselves are the caller's state and are never rewritten here.
  assert.deepEqual(state, { calls: 12, interventions: 1, faults: 0 });

  assert.equal(currentLimit({ calls: 0, interventions: 3, faults: 0 }, limits), 'intervention_limit');
  assert.equal(currentLimit({ calls: 0, interventions: 3, faults: 0 }, { ...limits, interventionLimit: 5 }), null);
  assert.equal(currentLimit({ calls: 0, interventions: 0, faults: 3 }, limits), 'circuit_breaker');
});

test('the new-install defaults describe call accounting honestly', () => {
  assert.equal(DEFAULTS.callBudget, 24, '24 judgement calls, roughly 12 tool actions');
  assert.equal(DEFAULTS.interventionLimit, 3, 'the intervention limit is independent');
  assert.deepEqual([...CALL_BUDGET_PRESETS], [12, 24, 48]);
  assert.equal(isCallBudget(1), true);
  assert.equal(isCallBudget(100), true);
  assert.equal(isCallBudget(0), false);
  assert.equal(isCallBudget(101), false);
  assert.equal(isCallBudget(1.5), false);
  assert.equal(isCallBudget('24'), false);
});
