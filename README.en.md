# Jev Supervisor for DeepSeek Harness

[简体中文](./README.md) · **English**

An external Cordis plugin for DeepSeek Harness (macOS Desktop / `dsh web`). Before and after every tool call it asks the TypeSafe supervision API (`api.typesafe.ai/v1/systemone`, pinned model **jev-1.13.0**) whether the call should proceed, and — once you explicitly enable enforcement — can block the call, pause for your decision, or attach evidence-backed corrective context to the next step.

Supervision data is sent to **TypeSafe**, with **your own** TypeSafe key.

> Compatibility: developed and verified against **DeepSeek Harness Desktop 0.2.0-rc.2** (commit `5e9e301`, macOS arm64). DSH is pre-1.0; this plugin uses only extension points and services that version publishes. Read [compatibility](./docs/INSTALL.md#compatibility) before changing versions.

---

## What it does

One tool call, end to end:

| Stage | Supervision |
|---|---|
| The model wants to call a tool | The original approval/safety gate runs first. A denial or cancellation there is never overridden. Only an `allow` triggers one Jev request. |
| The judgment says block | The call is denied; the tool body **does not run**. The model receives an error result carrying the cited evidence. |
| The judgment needs a user decision | An `ask` goes through the Harness approval channel; a refusal means the call does not run. |
| The tool finished | A second judgment. If the method should change, the real result is **not** rewritten — one corrective context is attached to the next step. |
| The judgment asks to pause | The turn ends blocked. No automatic re-plan and no forced continuation; you decide, then `/jev resume`. |

Judgments read a **real, bounded** state snapshot: the user's actual instructions, the explicit goal, turn/step position, real tool calls and failures, and the actual tool result. Full files, full history and keys are never sent.

**No extra DeepSeek summarization call**: the model route is untouched; supervision only calls TypeSafe.

## Surfaces

- **Under the composer (dock)**: `Jev`, mode, **connection**, **supervision**, details, refresh. Nothing else.
- **Settings → Jev Supervisor**: key form, connection check, mode, enable enforcement, clear key. The "data goes to TypeSafe" statement appears once, here.
- **First-run setup panel**: appears once when no key is configured (closable, with "set up later"; never repeated). A user who already has a key never sees it, and a stored key is never rendered back.

### Connection ≠ being supervised

The two facts are shown separately, because they are separate:

| Shown | Meaning |
|---|---|
| Connection: Connected / No key / Unreachable / Unchecked | Whether the TypeSafe API answers at all. **"Unchecked" means no real request has ever succeeded**; a stored key is not a working connection. A successful supervised call updates it to Connected and records the time; a real failure updates it by cause. Nothing is "fixed up" by an extra probe request. |
| Supervision: Supervising / Recording / Limited / Awaiting you / Not supervised / Unchecked | Whether this session's task is still under supervision. |

**"Limited" has three causes**, named in the label and in the details line: `budget spent` (per-task call budget exhausted), `intervention cap`, `fault circuit` (three consecutive failures). A limited task keeps running normally — it simply is not supervised any more. **The connection can read "Connected" while supervision reads "Limited"**; the first is not evidence of the second.

The budget is accounted per **session task** (per goal when the session has an explicit one). The details line names which, so no task boundary is invented.

## Install

Full steps in [docs/INSTALL.md](./docs/INSTALL.md). Shortest path:

1. Harness sidebar → **Plugins** → **Add plugin**.
2. In the spec field enter:

   ```
   https://github.com/ryyyzer/jev-supervisor.git#v1.0.0
   ```

   `#v1.0.0` pins the installed code to that tag so later changes cannot affect it; drop the `#` to follow the repository. The default branch and the only published release are both v1.0.0.

3. Install. The package installs into the current profile as a bundle.
4. Restart Harness (a replaced/added package needs a fresh JavaScript module generation).
5. **Settings → Jev Supervisor** → paste your own TypeSafe key → **Save** (this runs one real connection check) → **Check, then enable enforcement**.

The default after installation is **shadow**: Jev is called and judgments are recorded, but nothing is ever blocked. With no key stored, no request is sent at all.

## Controls

| Surface | What it does |
|---|---|
| Settings page | Save/clear the key, verify the connection, off/shadow/enforce |
| `/jev status` | Mode, reachability, whether a key is configured, budget, task state (JSON) |
| `/jev off` \| `/jev shadow` \| `/jev enforce` | Switch mode; `off` makes no Jev call at all |
| `/jev resume` | Clear a pause (after ask_user) |
| `/jev reset` | Clear the **current task's** runtime state by hand (call/intervention/fault counters, pause, limit, feedback dedup) so this round's allowance is usable again; changes no mode, budget or credential |
| `/jev model jev-x.y.z` | Change the pinned version; aliases such as `latest` are refused |
| `/jev verify` | One real connection check with the stored key |
| `jev_supervisor_status` | Read-only tool. It **cannot** change mode, touch credentials, or widen authority |

## Security and data

- **The key goes through the official credential interface.** The form calls `ctx.remote.credentials.set(<this profile's reference>, …)`, which stores it in the Harness credential store (`dsh-credentials-local`). The plugin reads it back only through `ctx.credentials.resolve()` on the same reference.
- **The reference name is per profile**: it looks like `JEV_TYPESAFE_API_KEY_<10 hex>`, derived from `ctx.profileContext.dir`, and the settings page shows the actual name. Two profiles in one harness home write two entries and can neither read nor overwrite each other's. Save, describe, verify, replace and clear all address that one name.
  - A deployment that needs a fixed name can set `keyRef` in `cordis.patch.yml`.
  - Upgrading from 1.0.x (fixed name `JEV_TYPESAFE_API_KEY`) means the key sits in the old entry: **enter it again on the settings page**. The plugin does not read the old entry, migrate it, or copy it.
- The key **never** enters model messages, session history, `cordis.patch.yml`, plugin source, logs, tool results, command-line arguments, `localStorage` or `sessionStorage`. Tests assert this (snapshot redaction, log scrubbing, source scan, no plaintext in the audit log).
- **The plugin does not retain the key**: it resolves it from the store for each supervision call and releases it immediately. Clearing the key, switching the API off, or unloading the plugin leaves no old value inside the plugin, and the one copy needed for log redaction exists only for the duration of a single call.
- Where the credential file lives and how well it is protected is the Harness's decision. This plugin adds no second store and **does not claim macOS Keychain or any system-level secure storage**. The official local provider is a file (default `$DSH_HOME/.credentials.yaml`, owner-only `0600`, directory `0700`, atomic replacement on write): it keeps other OS users out and **cannot keep out agent tool processes running as you**. That is `dsh-credentials-local`'s own documented boundary, and this plugin inherits it honestly. Details in [docs/SECURITY.md](./docs/SECURITY.md).
- For stronger isolation, launch with the reference in the environment: `JEV_TYPESAFE_API_KEY_<your digest>=… open -a "DeepSeek Harness"`. Harness then reports that reference as read-only, and the settings page says so instead of pretending it can replace it.

What is sent to TypeSafe, how it is redacted, and what is never sent: [docs/SECURITY.md](./docs/SECURITY.md).

## Operating limits

- **Jev call budget**: the settings page (and the first-run panel) offers **12 / 24 / 48 / custom**, defaulting to **24** on a new install; a custom value is any whole number from 1 to 100. **A tool action is usually judged once before and once after it runs, and each judgement counts as one call**, so 24 covers roughly 12 tool actions. A higher budget is **not** a token saving and not an accuracy guarantee.
- **Actual intervention limit** stays **3** by default and is **independent** of the call budget: it counts only real interventions (deny / ask / corrective feedback) and lives under **Advanced** in the settings page.
- Counting scope: the real goal task when one exists, otherwise the session. **Changing a budget, refreshing, switching modes or re-rendering never zeroes the spend**; raising a budget lets a limited task resume on the next read, carrying the calls it already spent. The surfaces always show the effective value and the spend the Host reports.
- An exhausted budget is shown as `Limited (budget spent)` and returns to the original flow; it is never reported as a connection fault, and the budget never becomes unlimited.
- **5 s** per request; the circuit breaker trips after **3** consecutive faults (a success resets it). No automatic retry.
- Low confidence, insufficient evidence, duplicate evidence, exhausted budget, faults or cancellation all **return to the original flow**. The original safety approval always stands.
- A pause (ask_user) ends the blocked turn; Stop-continuation is never forced.
- Snapshot budget **8000 bytes** (configurable 2000–16000); over budget, recent results and failures are dropped first.
- Probabilities and confidence are **not** accuracy guarantees.

## Reusing a budget by hand (/jev reset)

A spent budget is never topped up automatically. Making this round's allowance usable again is an explicit `/jev reset` from you. There is no automatic reset and no unlimited budget.

With the budget set to 12:

1. After 12 judgements Jev stops calling and **your original task keeps running**. The control reads `Connected · Limited (budget spent)`. The 12 are **judgement calls**: since a tool action is usually judged once before and once after it runs, 12 usually covers about **6 tool actions**.
2. Send `/jev status` in the conversation to see the current mode, the counters and the limits.
3. **While the task is idle — no tool running and no unsettled Jev request** — send `/jev reset`, then `/jev status` again to confirm the counters are back to zero and the limit is still 12. This clears counters; it does **not** change the budget.
4. The 12 judgements are available again, and you can repeat this round after round.

> **Concurrency**: reset only when idle. A reset replaces that task's runtime state, so a judgement still in flight when you reset is discarded at settlement and recorded as `task_reset` (the call was already spent and is not written back). "Safe to reset at any moment" is **not** verified, so this document only promises what idle resetting does.

Facts that matter:

- **Every new round produces real TypeSafe API usage and cost.** 12 is not a free allowance and not a cumulative spend cap.
- A reset clears only the current **task's** runtime state: call count, intervention count, fault count and circuit, pause, limit, and the feedback evidence dedup set. It **does not delete the session's original failure records**, so the same failure evidence can intervene again.
- A reset changes **no** mode, configured budget, intervention limit or credential; under `off` a reset does **not** switch supervision on. It cancels no executed tool, retracts no feedback already sent, and clears neither the conversation nor the audit log. It is not a fix for a network or credential fault either.
- Counting scope: the current goal task when a real goal id exists, otherwise the whole session. Sending more messages in the same conversation does **not** add allowance.
- **A budget change is not a reset**: raising 12 to 24 keeps the 12 already spent and only lifts the ceiling, whereas a reset zeroes the spend. Refreshing, switching modes and re-rendering never zero it.
- **Only an explicit user command clears counters.** The read-only `jev_supervisor_status` tool cannot perform a reset for the model, and nothing adds allowance in a loop or forces continuation.

## What the audit records

Each real judgement gets its own line (`kind: pre` / `post`) carrying the session, turn/step, call id, tool name, action, evidence fingerprint, DeepSeek usage — and **the complete judgement metadata**:

```jsonc
{
  "kind": "pre", "tool": "read", "action": "none", "reason": "low_confidence",
  "decision": "replan",              // normalized choice, for filtering
  "judgment": {                      // the numbers the decision came from
    "choice": "replan",
    "confidence": 0.84,
    "probabilities": { "continue": 0.15, "replan": 0.84, "ask_user": 0.01 },
    "repeatedFailure": 0.2, "goalDrift": 0.1,
    "model": "jev-1.13.0",           // the model the API answered with, validated against the pinned version
    "usage": { "input_tokens": 1435, "output_tokens": 78 },
    "latencyMs": 697, "at": "…", "unknown": false
  }
}
```

- **Nothing is invented**: a field the API did not supply is `null` with `unknown: true`, never a fabricated `0`. A skipped stage (off, exhausted budget, an original denial) writes `judgment: null`, so it cannot be read as a call that happened.
- A `connection-verified` record is a different event and never substitutes for per-judgement auditing.
- The log stays a local file and is **never injected into model context** (least of all in shadow).
- When corrective feedback enters the next request, its source identity is the **producer-owned kind** the installed session format V4 requires: `plugin:dsh-plugin-jev-supervisor`. It is not `user` (which would let supervision's wording pass as your own instruction) and not the retired V3 wrapper `plugin` (which V4 refuses). `test/v4-contract.test.js` holds this contract against the installed package's real row admission.

## Where data lives

- Settings: the official storage domain `ctx.storageDomain` when mounted, otherwise `.jev-supervisor/settings.json` inside the **profile directory**.
- Log: `<profile dir>/.jev-supervisor/supervisor.jsonl` (directory 0700, file 0600, 5 MiB rotation keeping one `.previous`).
- The only source of location is `ctx.profileContext`. There is **no** hard-coded user name, profile name, keychain service or absolute path; installing into two profiles yields two independent data sets.

## Uninstall

Sidebar **Plugins** → this plugin → uninstall. Credentials are not deleted automatically; clear the key on the settings page (the official entry point for `ctx.credentials.unset('JEV_TYPESAFE_API_KEY')`).

Upgrade: the current DSH plugin management has no in-place upgrade — uninstall, then install the new version. Settings and credentials survive.

## Development

```bash
npm run prepare:runtime   # once: link an installed Harness into the test fixture
npm test                  # 109 checks: 43 core, 7 store, 16 client, 38 real-runtime integration, 5 V4 source-contract
```

The integration half loads the **installed** `@deepseek-ai/dsh-tools` / `dsh-commands` and drives the real `tools/pre-execute` waterfall, guard, `tools/post-execute` and `tools/result` ordering, replacing only the outbound TypeSafe `fetch`. "A denial does not run the tool body" is therefore proved against the real scheduler, not a mock event bus.

The integration tests need the real Harness packages, and the fixture is built by one explicit command (symlinks only — nothing is installed and no existing file is modified):

```bash
DSH_TEST_RUNTIME=/path/to/installed/dsh/node_modules \
DSH_TEST_PROFILE=~/.dsh/profiles/desktop/node_modules \
node test/prepare-runtime.mjs
```

`DSH_TEST_RUNTIME` is an installed Harness `node_modules` (extract it from `app.asar`, or use your own checkout); `DSH_TEST_PROFILE` is any real profile's `node_modules`, which supplies third-party packages the runtime does not hoist, such as `zod`. The fixture lands in `test/runtime/`, is **not** published, and is listed in `.gitignore`; `npm test` checks for it first and prints that command when it is missing.

## License

MIT, see [LICENSE](./LICENSE).
