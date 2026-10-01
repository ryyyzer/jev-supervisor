/**
 * Jev Supervisor — per-agent wiring.
 *
 * Everything here is registered on one agent's own context, so disposal of that
 * agent removes it, and the plugin's own effect removes it too. Two agents never
 * share decision state: the denial map, the pending-feedback map, and the task
 * budget all live inside one `attachAgent` call.
 *
 * Extension points, weakest that suffices:
 * - `tools/pre-execute` (waterfall): observe the original gate and return it
 *   unchanged unless supervision denies or asks. The original safety decision is
 *   never replaced with our own allow.
 * - `tools.guard()` (monotonic denial): makes an asynchronously decided denial
 *   survive any later waterfall listener that would let the call through.
 * - `tools/post-execute` (waterfall): attach corrective context to a committed
 *   result without replacing its success or error fact.
 * - `agent/pre-step`: end a blocked turn for a pending user decision, and record
 *   whether appended feedback was actually admitted.
 *
 * @module dsh-plugin-jev-supervisor/adapter
 */
import { makeSnapshot } from './core.js';

/**
 * Run `body` as one disposable effect on `context` when that context supports
 * effects, and fall back to running it directly otherwise.
 *
 * An agent's own context normally carries `effect`, which is what ties these
 * registrations to that agent's lifetime. The fallback exists so a context that
 * exposes only the event surface still works instead of throwing; the plugin's
 * own disposer removes the registrations either way.
 *
 * @param context - context to register on.
 * @param body - registration body returning disposers.
 * @returns a disposer for everything the body registered.
 */
function register(context, body) {
  if (typeof context?.effect === 'function') return context.effect(body);
  const disposers = body();
  return () => {
    for (const dispose of [...disposers].reverse()) dispose();
  };
}

/**
 * Project one validated judgement into the audit record.
 *
 * Only fields the API actually answered are copied. A missing number is
 * reported as `null` plus `unknown: true` rather than as `0`, because a zero
 * probability and an unmeasured one must not look the same in an audit trail.
 *
 * @param judgment - the validated judgement returned by {@link Supervisor.judge}.
 * @returns a plain object safe to log.
 */
function summariseJudgment(judgment) {
  const probabilities = judgment.probabilities && typeof judgment.probabilities === 'object' ? judgment.probabilities : undefined;
  const usage = judgment.usage && typeof judgment.usage === 'object' ? judgment.usage : undefined;
  const numberOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    choice: typeof judgment.choice === 'string' ? judgment.choice : null,
    confidence: numberOrNull(judgment.confidence),
    probabilities: probabilities
      ? {
          continue: numberOrNull(probabilities.continue),
          replan: numberOrNull(probabilities.replan),
          ask_user: numberOrNull(probabilities.ask_user),
        }
      : null,
    repeatedFailure: numberOrNull(judgment.repeatedFailure),
    goalDrift: numberOrNull(judgment.goalDrift),
    // The version the API answered with, which validation already proved equal
    // to the pinned request.
    model: typeof judgment.model === 'string' ? judgment.model : null,
    usage: usage ? { input_tokens: numberOrNull(usage.input_tokens), output_tokens: numberOrNull(usage.output_tokens) } : null,
    latencyMs: numberOrNull(judgment.latencyMs),
    at: typeof judgment.at === 'string' ? judgment.at : null,
    unknown: !probabilities || !usage || typeof judgment.confidence !== 'number' || typeof judgment.at !== 'string',
  };
}

/**
 * Check the shape supervision is about to hand to the session, and refuse the
 * two shapes a session format refuses.
 *
 * The installed format is V4, whose admission requires a nonempty producer-owned
 * source kind and explicitly rejects the retired V3 wrapper `kind: 'plugin'`.
 * Checking it here keeps a broken contract from reaching the durable write, where
 * it would break the turn instead. The authoritative check lives in the session
 * format package; `test/v4-contract.test.js` runs this message through that real
 * admission as well.
 *
 * @param message - candidate corrective-context message.
 * @throws Error when the message is not admissible.
 */
export function assertFeedbackShape(message) {
  const kind = message?.source?.kind;
  if (typeof kind !== 'string' || kind.length === 0) throw new Error('feedback requires a nonempty source kind');
  if (kind === 'plugin') throw new Error('format v4 message requires a producer-owned source kind');
  if (kind === 'user') throw new Error('supervision feedback must not claim user authority');
  if (typeof message.id !== 'string' || message.id.length === 0) throw new Error('feedback requires an id');
  if (!Array.isArray(message.content) || message.content.length === 0) throw new Error('feedback requires content');
}

/**
 * Attach supervision to one live agent.
 *
 * @param ctx - plugin context (for the log and dependency access).
 * @param agent - the live agent.
 * @param supervisor - shared supervision state.
 * @param options - `readProjection`, `log`, `save`, `createContext`.
 * @returns a disposer that removes every registration this call made.
 */
export function attachAgent(ctx, agent, supervisor, { readProjection, log, save = () => {}, createContext } = {}) {
  /** Denials decided asynchronously, held for the monotonic guard. */
  const denied = new Map();
  /** Feedback committed to the result, awaiting proof that it reached a request. */
  const pending = new Map();

  const taskId = () => {
    const projection = readProjection(agent);
    return `${agent.id}:${projection?.goal?.id ?? 'session-task'}`;
  };

  const audit = (kind, exec, out, extra = {}) => {
    const projection = readProjection(agent);
    log({
      kind,
      sessionId: agent.id,
      taskId: taskId(),
      turn: projection?.turn ?? null,
      step: projection?.step ?? null,
      callId: exec?.callId ?? null,
      rootCallId: exec?.rootCallId ?? null,
      tool: exec?.name ?? null,
      decision: out?.judgment?.choice ?? out?.decision ?? null,
      action: out?.action ?? 'none',
      reason: out?.reason ?? null,
      evidence: out?.fingerprint ?? null,
      /**
       * The complete judgement this decision was made from.
       *
       * A tool judgement is only auditable if the numbers behind it are on the
       * record: the choice, every option's probability, the confidence, both
       * "no user-level evidence" values, and the model, usage and latency of the
       * call that produced them. Anything the API did not supply stays null with
       * `unknown: true` — never a fabricated zero. A skipped judgement (budget,
       * off, original denial) carries `judgment: null` and says so, so it can
       * never be read as a call that happened.
       */
      judgment: out?.judgment ? summariseJudgment(out.judgment) : null,
      deepseek: projection?.deepseekUsage ?? 'unknown',
      ...extra,
    });
  };

  return register(agent.ctx, () => {
    const disposers = [];

    // Monotonic denial: registered after the pre-execute waterfall, so a later
    // listener cannot turn our denial back into an allow. A guard is
    // synchronous, so only the denial reason is read here; the map is keyed by
    // execution token, which keeps it per-call even though the registry is the
    // plugin's injected singleton.
    disposers.push(ctx.tools.guard(exec => denied.get(exec.token)));

    /**
     * Announce the transition into a limited state exactly once per task, so the
     * audit trail records WHEN supervision stopped and WHY, instead of leaving a
     * long run of unexplained no-ops after the budget is spent.
     */
    let announcedLimit = null;
    const announceLimit = (budget, exec) => {
      const limit = budget.limit;
      // Track the derived limit so a raised budget and a newly hit limit are
      // both announced exactly once; nothing is reset by the change itself.
      if (limit === announcedLimit) return;
      const previous = announcedLimit;
      announcedLimit = limit;
      if (limit === null) {
        if (previous !== null) audit('limit-lifted', exec, { action: 'none', reason: 'limit_raised' }, { previousLimit: previous });
        return;
      }
      audit('limited', exec, { action: 'none', reason: budget.limitReason ?? budget.reason, limit }, {
        limit,
        // The judgement that happened to be last before the limit is kept, but it
        // is not what the limit is reported as.
        lastDecisionReason: budget.lastDecisionReason ?? null,
        calls: budget.calls,
        callBudget: budget.callBudget,
        interventions: budget.interventions,
        interventionLimit: budget.interventionLimit,
        faults: budget.faults,
        note: 'supervision stopped for this task; the original task continues',
      });
    };

    disposers.push(
      agent.ctx.on('tools/pre-execute', async (exec, next) => {
        const prior = await next();
        if (supervisor.config.mode === 'off') return prior;
        // Preserve the original safety decision: a cancellation, an existing
        // denial, or an approval request outranks supervision.
        if (prior.kind !== 'allow') {
          audit('pre', exec, { action: 'none', reason: `original_${prior.kind}` });
          return prior;
        }
        const snapshot = makeSnapshot(readProjection(agent), exec, undefined, supervisor.config.snapshotBytes);
        const out = await supervisor.judge({ taskId: taskId(), snapshot, signal: exec.signal, stage: 'pre' });
        save();
        announceLimit(supervisor.budgetOf(taskId()), exec);
        if (out.action === 'deny') {
          denied.set(exec.token, out.feedback);
          audit('pre', exec, out);
          return { kind: 'deny', reason: out.feedback };
        }
        if (out.action === 'ask') {
          audit('pre', exec, out);
          return { kind: 'ask', reason: out.feedback };
        }
        audit('pre', exec, out);
        return prior;
      }),
    );

    disposers.push(
      agent.ctx.on('tools/post-execute', async (exec, result, next) => {
        const prior = await next();
        // Only a plain accept is ours to extend: a block, or a listener that
        // already replaced the content or the value, stays exactly as it is.
        if (supervisor.config.mode === 'off' || prior.kind !== 'accept') return prior;
        if (Object.hasOwn(prior, 'value') || Object.hasOwn(prior, 'content')) return prior;
        const snapshot = makeSnapshot(readProjection(agent), exec, result, supervisor.config.snapshotBytes);
        const out = await supervisor.judge({ taskId: taskId(), snapshot, signal: exec.signal, stage: 'post' });
        save();
        announceLimit(supervisor.budgetOf(taskId()), exec);
        audit('post', exec, out, { actualResult: { isError: result.isError, code: result.error?.info?.code ?? null } });
        if (out.action !== 'feedback') return prior;
        // The message builder owns the identity and the plugin-role source, so
        // supervision's own wording can never read as a user instruction.
        /**
         * Build the corrective context inside a boundary.
         *
         * Supervision must never be the reason a turn breaks: if the message
         * cannot be built, or is not the shape the installed session format
         * admits, supervision drops its own addition and the real tool result
         * continues exactly as it was. The failure is recorded rather than
         * swallowed, so a broken contract is visible instead of silent.
         */
        let message;
        try {
          message = createContext(out.feedback);
          assertFeedbackShape(message);
        } catch (error) {
          audit('feedback-rejected', exec, { action: 'none', reason: 'message_not_admitted' }, {
            feedbackError: String(error?.message ?? error).slice(0, 200),
            note: 'the original tool result continues unchanged',
          });
          return prior;
        }
        pending.set(message.id, { callId: exec.callId, text: out.feedback });
        // Accept without replacing content or value: the real tool outcome
        // survives untouched, and the corrective context rides beside it.
        return { ...prior, additionalContexts: [...(prior.additionalContexts ?? []), message] };
      }),
    );

    disposers.push(
      agent.ctx.on('tools/result', (exec, result) => {
        denied.delete(exec.token);
        if (supervisor.config.mode !== 'off') {
          audit('result', exec, null, { actualResult: { isError: result.isError, code: result.error?.info?.code ?? null } });
        }
      }),
    );

    disposers.push(
      agent.ctx.on('agent/pre-step', async (payload, next) => {
        const prior = await next();
        if (supervisor.config.mode === 'off' || prior.kind === 'reject') return prior;
        const state = supervisor.task(taskId());
        if (state.paused) {
          // Ending this turn is the whole intervention: no Stop continuation, no
          // automatic re-plan. The user decides, then resumes explicitly.
          audit('pre-step', null, { action: 'reject', reason: 'needs_user' });
          return { kind: 'reject' };
        }
        for (const [id, proof] of pending) {
          const present = prior.messages.some(message => message.id === id);
          audit('feedback-admission', null, { action: present ? 'admitted' : 'not_admitted', reason: 'pre-step_messages' }, {
            messageId: id,
            callId: proof.callId,
          });
        }
        return prior;
      }),
    );

    // Admission evidence read from the durable session log: proves the feedback
    // was committed, which is weaker than proving it reached a request.
    disposers.push(
      agent.ctx.on('session/event', (_session, event) => {
        if (event.type === 'user/message' && pending.has(event.data.id)) {
          const proof = pending.get(event.data.id);
          audit('feedback-committed', null, { action: 'committed', reason: 'agent_inbox_splice' }, {
            messageId: event.data.id,
            seq: event.seq,
            callId: proof.callId,
          });
        }
      }),
    );

    // The strongest available proof: the frozen message list of an actual model
    // request, compared by message id and by text.
    disposers.push(
      agent.ctx.on('llm/stream', async function* (options, next) {
        if (options.sessionId === agent.id && pending.size) {
          for (const [id, proof] of pending) {
            const present = options.messages.some(
              message => message.id === id || message.content?.some(block => block.type === 'text' && block.text === proof.text),
            );
            audit('feedback-actual-model-request', null, { action: present ? 'present' : 'absent', reason: 'llm/stream frozen request' }, {
              messageId: id,
              callId: proof.callId,
              provider: options.provider,
              model: options.model,
            });
            if (present) pending.delete(id);
          }
        }
        yield* next();
      }),
    );

    return () => {
      for (const dispose of [...disposers].reverse()) dispose();
      denied.clear();
      pending.clear();
    };
  });
}
