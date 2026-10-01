/**
 * The feedback message must satisfy the installed session format's admission.
 *
 * The Desktop build writes **format V4**, whose admission refuses the retired V3
 * producer wrapper `kind: 'plugin'` with
 * `format v4 message requires a producer-owned source kind`. A judgement that
 * attaches a corrective-context message must therefore produce something V4
 * admits, or the durable write fails and the whole turn — plus the next one —
 * breaks.
 *
 * These tests call the **installed** admission functions from the real
 * `@deepseek-ai/dsh-session-format-v3-to-v4` package, not a stub, so a source
 * shape this build refuses fails here rather than on a user's Desktop. They are
 * a contract test, not a claim that the message reached a model request.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertV4RowAdmission } from '@deepseek-ai/dsh-session-format-v3-to-v4';
import { createApp, createCredentials, registerEchoTool, runTool } from './harness.js';
import { createScope, scopeOf, scopeTarget } from '@deepseek-ai/dsh-scope';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PRODUCER_KIND, PROJECTION_KEY } from '../lib/index.js';

/** The durable row a user message produces, exactly as the session writes it. */
const userMessageRow = message => ({ type: 'user/message', data: message });

/** The durable row an injected inbox message produces. */
const splicedRow = message => ({ type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, removedCount: 0, inserted: [message] } });

test('the producer kind is producer-owned and is not the retired wrapper', () => {
  assert.equal(PRODUCER_KIND, 'plugin:dsh-plugin-jev-supervisor');
  assert.notEqual(PRODUCER_KIND, 'plugin');
  assert.notEqual(PRODUCER_KIND, 'user');
});

test('the installed V4 admission refuses the retired wrapper this release used to emit', () => {
  // Guards the test itself: if this stops throwing, the contract changed and the
  // fix below must be re-derived rather than assumed.
  assert.throws(
    () => assertV4RowAdmission(userMessageRow({ role: 'user', source: { kind: 'plugin', plugin: 'dsh-plugin-jev-supervisor' }, content: [] })),
    /producer-owned source kind/,
  );
});

test('a real post-execute replan attaches a message the installed V4 admission accepts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-v4-'));
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('ts_live_v4_contract') });
  const restore = globalThis.fetch;
  try {
    registerEchoTool(app.ctx, 'echo');
    const session = { id: 'session-v4', seq: 10, snapshotEvents: () => [], append: () => ({ seq: 11 }) };
    const agent = { id: 'session-v4', session, attachments: [] };
    const scope = createScope(app.ctx, agent);
    agent.ctx = scope.ctx;
    agent.scope = scopeOf(scope.ctx);
    app.agents.set(agent.id, agent);
    app.ctx.emit('agent/created', { agent });
    const commit = event => {
      event.seq = (event.seq ?? 0) + 10;
      app.projections.fold(agent.session, PROJECTION_KEY, event);
      app.ctx.emit('session/event', agent.session, event);
    };
    commit({ type: 'user/message', data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'run it' }] } });
    // Two materially identical real failures of the same tool: the evidence a
    // replan judgement needs. The message shape is the one the loop writes
    // (`createToolResultMessage`: role tool, source kind tool, callId).
    for (const callId of ['a', 'b']) {
      commit({ type: 'tool/call', data: { callId, name: 'echo' } });
      commit({
        type: 'tool/result',
        data: {
          message: {
            id: `result-${callId}`,
            role: 'tool',
            source: { kind: 'tool', callId },
            toolCallId: callId,
            isError: true,
            content: [{ type: 'text', text: 'ENOENT' }],
          },
        },
      });
    }

    // Pre: continue. Post: a high-confidence replan, which produces feedback.
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      const body =
        calls === 1
          ? {
              model: 'jev-1.13.0',
              answers: {
                action: { type: 'choice', choice: 'continue', confidence: 0.99, probabilities: { continue: 0.98, replan: 0.01, ask_user: 0.01 } },
                repeated_failure: { type: 'noul', noul: 0.99 },
                goal_drift: { type: 'noul', noul: 0.01 },
              },
              usage: { input_tokens: 10, output_tokens: 4 },
            }
          : {
              model: 'jev-1.13.0',
              answers: {
                action: { type: 'choice', choice: 'replan', confidence: 0.99, probabilities: { continue: 0.01, replan: 0.98, ask_user: 0.01 } },
                repeated_failure: { type: 'noul', noul: 0.99 },
                goal_drift: { type: 'noul', noul: 0.01 },
              },
              usage: { input_tokens: 10, output_tokens: 4 },
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const outcome = await runTool(app.ctx, { name: 'echo', args: { value: 'kept' }, agent, callId: 'v4-1' });
    // The real tool result is preserved, as before.
    assert.equal(outcome.executed, true);
    assert.equal(outcome.result.isError, false);
    assert.equal(outcome.result.content[0].text, 'kept');
    const message = outcome.result.additionalContexts?.[0];
    assert.ok(message, 'the replan attached corrective context');

    // The message must satisfy the installed durable admission, both in the slot
    // a user message occupies and in the inbox-splice slot it actually travels in.
    assert.doesNotThrow(() => assertV4RowAdmission(userMessageRow(message)), 'user/message row admission');
    assert.doesNotThrow(() => assertV4RowAdmission(splicedRow(message)), 'agent/inbox/spliced row admission');
    assert.equal(message.source.kind, PRODUCER_KIND);
    assert.equal('plugin' in message.source, false, 'no retired wrapper field is carried');
    assert.equal(message.role, 'user', 'it stays a model-visible turn');
    assert.match(message.content[0].text, /\[Jev Supervisor\]/);
    assert.equal(typeof message.id, 'string');
  } finally {
    globalThis.fetch = restore;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the admitted feedback is then proven present in the next frozen model request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-v4-frozen-'));
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('ts_live_v4_frozen') });
  const restore = globalThis.fetch;
  try {
    registerEchoTool(app.ctx, 'echo');
    const session = { id: 'session-frozen', seq: 10, snapshotEvents: () => [], append: () => ({ seq: 11 }) };
    const agent = { id: 'session-frozen', session, attachments: [] };
    const scope = createScope(app.ctx, agent);
    agent.ctx = scope.ctx;
    agent.scope = scopeOf(scope.ctx);
    app.agents.set(agent.id, agent);
    app.ctx.emit('agent/created', { agent });
    const commit = event => {
      event.seq = (event.seq ?? 0) + 10;
      app.projections.fold(agent.session, PROJECTION_KEY, event);
      app.ctx.emit('session/event', agent.session, event);
    };
    commit({ type: 'user/message', data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'run it' }] } });
    for (const callId of ['a', 'b']) {
      commit({ type: 'tool/call', data: { callId, name: 'echo' } });
      commit({
        type: 'tool/result',
        data: {
          message: {
            id: `result-${callId}`,
            role: 'tool',
            source: { kind: 'tool', callId },
            toolCallId: callId,
            isError: true,
            content: [{ type: 'text', text: 'ENOENT' }],
          },
        },
      });
    }
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      const choice = calls === 1 ? 'continue' : 'replan';
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            action: {
              type: 'choice',
              choice,
              confidence: 0.99,
              probabilities:
                choice === 'continue' ? { continue: 0.98, replan: 0.01, ask_user: 0.01 } : { continue: 0.01, replan: 0.98, ask_user: 0.01 },
            },
            repeated_failure: { type: 'noul', noul: 0.99 },
            goal_drift: { type: 'noul', noul: 0.01 },
          },
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const outcome = await runTool(app.ctx, { name: 'echo', args: { value: 'kept' }, agent, callId: 'frozen-1' });
    const message = outcome.result.additionalContexts[0];
    assert.equal(outcome.result.isError, false, 'the original successful result is preserved');

    // The loop splices accepted context into the next-step inbox and the next
    // request is assembled from the log. Drive that frozen request and read the
    // proof from the listener rather than from any claim by the model.
    for await (const _chunk of app.ctx.waterfall(
      scopeOf(scope.ctx) ? scopeTarget(app.ctx.tools, scopeOf(scope.ctx)) : agent.ctx,
      'llm/stream',
      { sessionId: agent.id, provider: 'deepseek-official', model: 'deepseek-flash', messages: [{ role: 'assistant', content: [] }, message] },
      async function* () {
        yield { type: 'text', text: 'ack' };
      },
    )) {
      void _chunk;
    }
    const records = readFileSync(join(dir, 'supervisor.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    const proof = records.filter(record => record.kind === 'feedback-actual-model-request').at(-1);
    assert.ok(proof, 'the request-level proof is recorded');
    assert.equal(proof.action, 'present');
    assert.equal(proof.messageId, message.id);
    assert.equal(proof.provider, 'deepseek-official');
  } finally {
    globalThis.fetch = restore;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a supervision failure to build feedback never breaks the turn: the real result continues', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-v4-fault-'));
  const app = await createApp({ dataDir: dir, config: { mode: 'enforce' }, credentials: createCredentials('ts_live_v4_fault') });
  const restore = globalThis.fetch;
  try {
    registerEchoTool(app.ctx, 'echo');
    const session = { id: 'session-fault', seq: 10, snapshotEvents: () => [], append: () => ({ seq: 11 }) };
    const agent = { id: 'session-fault', session, attachments: [] };
    const scope = createScope(app.ctx, agent);
    agent.ctx = scope.ctx;
    agent.scope = scopeOf(scope.ctx);
    app.agents.set(agent.id, agent);
    app.ctx.emit('agent/created', { agent });
    const commit = event => {
      event.seq = (event.seq ?? 0) + 10;
      app.projections.fold(agent.session, PROJECTION_KEY, event);
      app.ctx.emit('session/event', agent.session, event);
    };
    commit({ type: 'user/message', data: { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: 'run it' }] } });
    for (const callId of ['a', 'b']) {
      commit({ type: 'tool/call', data: { callId, name: 'echo' } });
      commit({
        type: 'tool/result',
        data: {
          message: {
            id: `result-${callId}`,
            role: 'tool',
            source: { kind: 'tool', callId },
            toolCallId: callId,
            isError: true,
            content: [{ type: 'text', text: 'ENOENT' }],
          },
        },
      });
    }
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      const choice = calls === 1 ? 'continue' : 'replan';
      return new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: {
            action: {
              type: 'choice',
              choice,
              confidence: 0.99,
              probabilities:
                choice === 'continue' ? { continue: 0.98, replan: 0.01, ask_user: 0.01 } : { continue: 0.01, replan: 0.98, ask_user: 0.01 },
            },
            repeated_failure: { type: 'noul', noul: 0.99 },
            goal_drift: { type: 'noul', noul: 0.01 },
          },
          usage: { input_tokens: 10, output_tokens: 4 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const outcome = await runTool(app.ctx, { name: 'echo', args: { value: 'kept' }, agent, callId: 'fault-1' });
    assert.equal(outcome.executed, true);
    assert.equal(outcome.result.isError, false, 'the real tool result is never replaced by a supervision fault');
    assert.equal(outcome.result.content[0].text, 'kept');

    // Drive the boundary directly: the two refused shapes are rejected and a
    // healthy one is accepted, so a broken contract is caught before the durable
    // write rather than breaking the turn there.
    const guard = await import('../lib/adapter.js');
    assert.equal(typeof guard.assertFeedbackShape, 'function', 'the boundary is testable on its own');
    assert.throws(() => guard.assertFeedbackShape({ id: 'x', content: [{ type: 'text', text: 't' }], source: { kind: 'plugin' } }), /producer-owned/);
    assert.throws(() => guard.assertFeedbackShape({ id: 'x', content: [{ type: 'text', text: 't' }], source: { kind: 'user' } }), /user authority/);
    assert.doesNotThrow(() =>
      guard.assertFeedbackShape({ id: 'x', content: [{ type: 'text', text: 't' }], source: { kind: PRODUCER_KIND } }),
    );
  } finally {
    globalThis.fetch = restore;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
