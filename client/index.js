// Jev Supervisor — client half.
//
// Hand-authored, no build step. Follows the shipped client bundle format:
//
//   window.__ModuleLoader__.load({ id, factory(require) { ... } })
//
// Three registrations:
//   · conversation.composer.dock — Jev · mode · connection · supervision · details · refresh
//   · settings.section           — the full settings page
//   · shell.overlay              — the first-run setup panel, shown once
//
// Connection health and supervision health are separate facts here. A reachable
// API says nothing about whether the current task is still being supervised, so
// the dock reports both and never lets "connected" imply "protected".
//
// The key never survives in this module's state after the save settles, is never
// written to localStorage/sessionStorage, and reaches the Host only through the
// official credential Remote namespace. Every operation that changes authority
// goes through an explicit button, and the Host proves the connection first.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-jev-supervisor',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Plugin namespace for locale registration; the Host route shares the name. */
    const NS = 'jev-supervisor';
    const ROUTE = '/api/jev-supervisor';
    /**
     * Fallback credential reference, used only before the Host reports the
     * profile-scoped name it actually owns. Every real operation uses the name
     * the status answer carries, because the reference is per profile.
     */
    const DEFAULT_KEY_REF = 'JEV_TYPESAFE_API_KEY';

    /** zh is the key-set source of truth; en carries the same keys. */
    const zh = {
      title: 'Jev',
      mode: '模式',
      modeOff: '关闭',
      modeShadow: '影子',
      modeEnforce: '强制',
      connected: '已连接',
      notConfigured: '未配置密钥',
      unreachable: '连接失败',
      unknown: '未检测',
      apiOff: 'API 已关闭',
      paused: '已暂停',
      // Supervision facts, deliberately separate from the connection facts.
      svNotConfigured: '未监督',
      svOff: '未监督',
      svUnverified: '未检测',
      svUnreachable: '未监督',
      svObserving: '影子记录',
      svRunning: '监督中',
      svLimited: '受限',
      svPaused: '待你决定',
      limitedBudget: '预算用尽',
      limitedInterventions: '干预达上限',
      limitedCircuit: '故障熔断',
      accountingSession: '按会话记账',
      accountingGoal: '按目标记账',
      keyScope: '凭据条目',
      // First-run setup.
      setupTitle: '配置 Jev Supervisor',
      setupIntro: '填入你自己的 TypeSafe key，检测连接，然后决定是否启用强制监督。',
      setupSteps: '1 填 key · 2 保存并检测 · 3 启用强制模式',
      setupLater: '稍后配置',
      setupDone: '已完成，关闭',
      setupClose: '关闭',
      setupAria: 'Jev Supervisor 首次配置',
      setupNoKey: '未配置 key 前，Jev 不会发出任何请求。',
      details: '详情',
      refresh: '刷新',
      working: '处理中…',
      failed: '操作失败',
      goSettings: '在「设置 → Jev Supervisor」填写你的 key。',
      calls: '调用',
      interventions: '干预',
      nav: 'Jev Supervisor',
      intro: 'Jev Supervisor 用 TypeSafe 的监督接口检查工具调用，判断基于真实且有限的状态快照。',
      keyLabel: 'TypeSafe API key',
      keyPlaceholderStored: '已保存；留空表示不修改',
      keyPlaceholderEmpty: '粘贴你自己的 key',
      keyAria: 'TypeSafe API key',
      keyHint:
        'key 只写入本机 Harness 凭据存储（官方凭据接口），不会进入配置、会话记录、模型请求、日志、工具结果、命令行参数或浏览器持久存储。',
      keyWritableNo: '当前凭据来自只读来源（例如启动环境变量或 .env），无法在这里覆盖。',
      noProvider: '这个 Harness 部署没有挂载凭据存储，无法保存 key。',
      save: '保存',
      remove: '清除密钥',
      saved: '已保存到本机凭据存储。',
      removed: '已清除本机保存的 key。',
      keyBlank: '请先填写 key。',
      verify: '检测连接',
      verifying: '正在检测…',
      verified: '连接正常：',
      verifyFailed: '连接失败：',
      enableEnforce: '检测并启用强制模式',
      enabling: '正在检测并启用…',
      enabled: '已启用强制模式。',
      enableNeedsKey: '需要先保存一个可用的 key。',
      modeLabel: '监督模式',
      modeOffHint: 'off：完全不调用 Jev。',
      modeShadowHint: 'shadow：调用 Jev 并记录判断，但不干预执行。',
      modeEnforceHint: 'enforce：证据阈值满足时拦截工具调用，或暂停并要求你决策。',
      budget: 'Jev 调用预算',
      budgetHint: '每次工具动作前后各可能判断一次，各计 1 次调用；24 次约覆盖 12 个动作。提高预算不保证更省 token，也不代表判断更准。',
      budgetPreset: '{n} 次',
      budgetCustom: '自定义',
      budgetCustomLabel: '自定义次数（1–100）',
      budgetInvalid: '请输入 1–100 之间的整数。',
      budgetApplied: '已生效：{n} 次调用。',
      budgetUsed: '本任务已用 {used} / {limit} 次',
      budgetCounting: '计数范围',
      advanced: '高级',
      interventionLabel: '实际干预上限',
      interventionHint: '与调用预算独立，只统计真正的干预（拒绝 / 询问 / 纠正反馈）。默认 3。',
      interventionApplied: '已生效：干预上限 {n} 次。',
      budgetKeepsCounts: '修改预算不会清零已用计数，也不会重置任务。',
      resume: '恢复',
      store: '设置存储',
      disclosure: '监督数据发送到 TypeSafe；概率与置信度不保证正确率。',
      uninstall: '卸载：在「插件」页移除本插件；已保存的 key 可在本页清除。',
      diagnostics: '诊断',
    };
    const en = {
      title: 'Jev',
      mode: 'Mode',
      modeOff: 'off',
      modeShadow: 'shadow',
      modeEnforce: 'enforce',
      connected: 'Connected',
      notConfigured: 'No key',
      unreachable: 'Unreachable',
      unknown: 'Unknown',
      apiOff: 'API off',
      paused: 'Paused',
      svNotConfigured: 'Not supervised',
      svOff: 'Not supervised',
      svUnverified: 'Unchecked',
      svUnreachable: 'Not supervised',
      svObserving: 'Recording',
      svRunning: 'Supervising',
      svLimited: 'Limited',
      svPaused: 'Awaiting you',
      limitedBudget: 'budget spent',
      limitedInterventions: 'intervention cap',
      limitedCircuit: 'fault circuit',
      accountingSession: 'per session',
      accountingGoal: 'per goal',
      keyScope: 'Credential entry',
      setupTitle: 'Set up Jev Supervisor',
      setupIntro: 'Add your own TypeSafe key, check the connection, then decide whether to enforce.',
      setupSteps: '1 key · 2 save and check · 3 enable enforcement',
      setupLater: 'Set up later',
      setupDone: 'Done, close',
      setupClose: 'Close',
      setupAria: 'Jev Supervisor first-time setup',
      setupNoKey: 'Until a key is configured, Jev sends no request at all.',
      details: 'Details',
      refresh: 'Refresh',
      working: 'Working…',
      failed: 'Failed',
      goSettings: 'Add your key in Settings → Jev Supervisor.',
      calls: 'calls',
      interventions: 'interventions',
      nav: 'Jev Supervisor',
      intro: 'Jev Supervisor checks tool calls through the TypeSafe supervision API, judging from a real, bounded state snapshot.',
      keyLabel: 'TypeSafe API key',
      keyPlaceholderStored: 'Stored; leave empty to keep it',
      keyPlaceholderEmpty: 'Paste your own key',
      keyAria: 'TypeSafe API key',
      keyHint:
        'The key is written only to this machine’s Harness credential store, through the official credential interface. It never enters configuration, session history, model requests, logs, tool results, command-line arguments or browser persistent storage.',
      keyWritableNo: 'The current credential comes from a read-only source (for example a launch environment variable or .env) and cannot be replaced here.',
      noProvider: 'This Harness deployment mounts no credential store, so a key cannot be saved.',
      save: 'Save',
      remove: 'Remove key',
      saved: 'Saved to the local credential store.',
      removed: 'Removed the locally stored key.',
      keyBlank: 'Enter a key first.',
      verify: 'Check connection',
      verifying: 'Checking…',
      verified: 'Reachable: ',
      verifyFailed: 'Connection failed: ',
      enableEnforce: 'Check, then enable enforcement',
      enabling: 'Checking, then enabling…',
      enabled: 'Enforcement enabled.',
      enableNeedsKey: 'Save a working key first.',
      modeLabel: 'Supervision mode',
      modeOffHint: 'off: no Jev call at all.',
      modeShadowHint: 'shadow: call Jev and record judgments without intervening.',
      modeEnforceHint: 'enforce: block a tool call, or pause and ask you, when the evidence thresholds are met.',
      budget: 'Jev call budget',
      budgetHint: 'A tool action is usually judged once before and once after it runs, and each judgement counts as one call; 24 covers roughly 12 actions. A higher budget is not a token saving and not an accuracy guarantee.',
      budgetPreset: '{n} calls',
      budgetCustom: 'Custom',
      budgetCustomLabel: 'Custom calls (1–100)',
      budgetInvalid: 'Enter a whole number between 1 and 100.',
      budgetApplied: 'Applied: {n} calls.',
      budgetUsed: '{used} / {limit} calls used by this task',
      budgetCounting: 'Counting scope',
      advanced: 'Advanced',
      interventionLabel: 'Actual intervention limit',
      interventionHint: 'Independent of the call budget; counts only real interventions (deny / ask / corrective feedback). Default 3.',
      interventionApplied: 'Applied: intervention limit {n}.',
      budgetKeepsCounts: 'Changing a budget never zeroes what a task already spent.',
      resume: 'Resume',
      store: 'Settings store',
      disclosure: 'Supervision data is sent to TypeSafe; probabilities and confidence are not accuracy guarantees.',
      uninstall: 'Uninstall: remove this plugin on the Plugins page; a stored key can be cleared on this page.',
      diagnostics: 'Diagnostics',
    };

    const CSS = `
.jev-dock{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.jev-dock strong{color:var(--dsw-alias-label-primary);font-weight:600}
.jev-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
.jev-dot[data-state=connected]{background:#16a34a}
.jev-dot[data-state=unreachable]{background:#d97706}
.jev-sep{color:var(--dsw-alias-border-l1)}
.jev-sv{display:inline-flex;align-items:center;gap:4px}
.jev-sv[data-state=running]{color:#16a34a}
.jev-sv[data-state=observing]{color:var(--dsw-alias-label-secondary)}
.jev-sv[data-state=limited],.jev-sv[data-state=paused]{color:#d97706}
.jev-sv[data-state=not_configured],.jev-sv[data-state=off],.jev-sv[data-state=unreachable],.jev-sv[data-state=unverified]{color:var(--dsw-alias-label-tertiary)}
.jev-mask{position:absolute;inset:0;z-index:130;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask,rgba(0,0,0,.42));padding:16px}
.jev-panel{box-sizing:border-box;width:min(520px,100%);max-height:calc(100vh - 32px);overflow:auto;background:var(--dsw-specific-menu,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.22));padding:18px 20px}
.jev-panel h2{margin:0;font-size:16px;font-weight:600}
.jev-panel p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.jev-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.jev-x{cursor:pointer;background:0 0;border:none;border-radius:6px;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:16px;padding:2px 6px}
.jev-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.jev-panel-body{display:flex;flex-direction:column;gap:12px;margin-top:12px}
.jev-panel-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.jev-steps{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.jev-btn{box-sizing:border-box;font:inherit;font-size:12px;line-height:16px;cursor:pointer;border-radius:7px;border:none;padding:3px 8px;background:var(--dsw-alias-interactive-bg-hover,transparent);color:var(--dsw-alias-label-primary)}
.jev-btn:hover{opacity:.85}
.jev-btn:disabled{opacity:.5;cursor:default}
.jev-btn-quiet{background:transparent;color:var(--dsw-alias-label-secondary)}
.jev-btn-primary{background:var(--dsw-alias-state-warn-tertiary,#4f46e5);color:var(--dsw-alias-state-warn-label,#fff)}
.jev-select{box-sizing:border-box;font:inherit;font-size:12px;line-height:16px;background:transparent;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 6px}
.jev-detail{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.jev-sec{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.jev-sec h2{margin:0;font-size:15px;font-weight:600}
.jev-sec p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.jev-field{display:flex;flex-direction:column;gap:6px}
.jev-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.jev-input{box-sizing:border-box;width:100%;font:inherit;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 9px}
.jev-input[aria-invalid=true]{border-color:#d97706}
.jev-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.jev-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.jev-msg{font-size:12px;line-height:18px}
.jev-msg[data-tone=ok]{color:#16a34a}
.jev-msg[data-tone=warn]{color:#d97706}
.jev-msg[data-tone=bad]{color:#dc2626}
.jev-choices{display:flex;flex-direction:column;gap:4px}
.jev-choice{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.jev-sep{border:0;border-top:.5px solid var(--dsw-alias-border-l2);margin:0}
.jev-kv{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
`;

    /** Inject the stylesheet once per document; a page reload re-injects it. */
    const CSS_ID = `${NS}/client.css`;
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = NS;
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /** Route helper: the authenticated same-origin `/api` channel, never cached. */
    async function call(path, options) {
      const response = await fetch(`${ROUTE}${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
        cache: 'no-store',
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(body?.code ?? `HTTP_${response.status}`);
      return body;
    }

    /** Map the Host reachability vocabulary onto one dot state. */
    function dotState(status) {
      if (!status) return 'unknown';
      if (!status.apiEnabled || status.mode === 'off') return 'off';
      return status.reachability ?? 'unknown';
    }

    /**
     * Subscribe to locale revisions so both registrations re-render on a
     * switch. A registry that reaches this module without the locale service
     * simply does not re-render on a language change; it never throws.
     */
    function useLocaleRevision(locale) {
      const live = React.useRef(true);
      React.useEffect(
        () => () => {
          live.current = false;
        },
        [],
      );
      const subscribe = React.useCallback(
        listener =>
          typeof locale?.subscribe === 'function'
            ? locale.subscribe(() => {
                if (live.current) listener();
              })
            : () => {},
        [locale],
      );
      const getSnapshot = React.useCallback(() => (typeof locale?.getSnapshot === 'function' ? locale.getSnapshot().revision : 0), [locale]);
      React.useSyncExternalStore(subscribe, getSnapshot);
    }

    /**
     * Translation accessor. Falls back to the bundled Simplified Chinese
     * dictionary so a missing locale binding degrades to readable text instead
     * of an empty control.
     */
    function translator(locale, bound, key) {
      if (typeof bound === 'function') {
        const text = bound(key);
        if (typeof text === 'string' && text !== '') return text;
      }
      return zh[key] ?? key;
    }

    /** Connection label keys. */
    const CONNECTION_KEYS = {
      connected: 'connected',
      not_configured: 'notConfigured',
      unreachable: 'unreachable',
      unverified: 'unverified',
      off: 'apiOff',
      unknown: 'unknown',
    };

    /** Supervision state label keys, and the limit that explains a `limited` state. */
    const SUPERVISION_KEYS = {
      not_configured: 'svNotConfigured',
      off: 'svOff',
      unverified: 'svUnverified',
      unreachable: 'svUnreachable',
      observing: 'svObserving',
      running: 'svRunning',
      limited: 'svLimited',
      paused: 'svPaused',
    };
    const LIMIT_KEYS = {
      call_budget: 'limitedBudget',
      intervention_limit: 'limitedInterventions',
      circuit_breaker: 'limitedCircuit',
    };

    /**
     * One status snapshot with its own loader, shared by every surface.
     * @param options - `sessionId` to scope the read, `intervalMs` for polling,
     *   and `until` to keep a fast retry going while its predicate holds (used
     *   while a Host dependency is still mounting, so a surface recovers on its
     *   own instead of staying disabled until the next manual refresh).
     */
    function useStatus({ sessionId, intervalMs = 20000, until, retryMs = 3000, retryForMs = 30000 } = {}) {
      const [status, setStatus] = React.useState(null);
      const [error, setError] = React.useState('');
      const mounted = React.useRef(true);
      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);
      const load = React.useCallback(async () => {
        try {
          const query = typeof sessionId === 'string' && sessionId !== '' ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
          const body = await call(`/status${query}`, { method: 'GET' });
          if (mounted.current) {
            setStatus(body);
            setError('');
          }
          return body;
        } catch {
          if (mounted.current) setError('failed');
          return undefined;
        }
      }, [sessionId]);
      React.useEffect(() => {
        void load();
        if (intervalMs === 0) return undefined;
        const timer = setInterval(() => void load(), intervalMs);
        return () => clearInterval(timer);
      }, [load, intervalMs]);

      // A fast retry while `until` says something is still missing. It is
      // bounded, so a deployment that genuinely has no provider does not poll
      // forever.
      React.useEffect(() => {
        if (typeof until !== 'function' || !until(status)) return undefined;
        const startedAt = Date.now();
        const timer = setInterval(() => {
          if (Date.now() - startedAt > retryForMs) {
            clearInterval(timer);
            return;
          }
          void load();
        }, retryMs);
        return () => clearInterval(timer);
      }, [load, retryMs, retryForMs, status, until]);

      return { status, error, load, setStatus };
    }

    /**
     * The credential operations shared by the settings page and the first-run
     * panel. The reference name always comes from the Host's status answer, so
     * save, describe, verify and clear address the same profile-scoped entry.
     */
    function useCredentialForm({ remote, status, t, onChanged }) {
      const credentials = remote?.credentials;
      const keyRef = status?.keyRef ?? DEFAULT_KEY_REF;
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [message, setMessage] = React.useState(null);
      const mounted = React.useRef(true);
      React.useEffect(() => {
        mounted.current = true;
        return () => {
          // Never leave typed key material behind after the surface closes.
          mounted.current = false;
          setDraft('');
        };
      }, []);

      const keyConfigured = status?.keyConfigured === true;
      const writable = status?.keyWritable !== false;
      const provider = status?.credentialProvider !== false && typeof credentials?.set === 'function';

      const save = async () => {
        const value = draft.trim();
        if (!provider) {
          setMessage({ tone: 'bad', text: t('noProvider') });
          return undefined;
        }
        if (value === '') {
          setMessage({ tone: 'warn', text: t('keyBlank') });
          return undefined;
        }
        setBusy('save');
        setMessage(null);
        let response;
        try {
          response = await credentials.set(keyRef, value);
        } catch (error) {
          setDraft('');
          setMessage({ tone: 'bad', text: `${t('failed')}: ${String(error?.message ?? error)}` });
          setBusy('');
          return undefined;
        }
        setDraft('');
        if (!response.ok) {
          setMessage({ tone: 'bad', text: `${t('failed')}: ${response.error?.message ?? ''}` });
          setBusy('');
          return { ok: false };
        }
        let result;
        try {
          result = await call('/verify', { method: 'POST', body: '{}' });
        } catch (error) {
          result = { ok: false, code: String(error?.message ?? error) };
        }
        setMessage(
          result.ok
            ? { tone: 'ok', text: `${t('saved')} ${t('verified')}${result.model} · ${result.latencyMs}ms` }
            : { tone: 'warn', text: `${t('saved')} ${t('verifyFailed')}${result.code}` },
        );
        await onChanged?.();
        if (mounted.current) setBusy('');
        return result;
      };

      const remove = async () => {
        if (typeof credentials?.unset !== 'function') {
          setMessage({ tone: 'bad', text: t('noProvider') });
          return undefined;
        }
        setBusy('remove');
        setMessage(null);
        try {
          const response = await credentials.unset(keyRef);
          setDraft('');
          setMessage(
            response.ok ? { tone: 'ok', text: t('removed') } : { tone: 'bad', text: `${t('failed')}: ${response.error?.message ?? ''}` },
          );
          await onChanged?.();
        } catch (error) {
          setDraft('');
          setMessage({ tone: 'bad', text: `${t('failed')}: ${String(error?.message ?? error)}` });
        } finally {
          if (mounted.current) setBusy('');
        }
        return undefined;
      };

      const verify = async () => {
        setBusy('verify');
        setMessage(null);
        let result;
        try {
          result = await call('/verify', { method: 'POST', body: '{}' });
        } catch (error) {
          result = { ok: false, code: String(error?.message ?? error) };
        }
        setMessage(
          result.ok
            ? { tone: 'ok', text: `${t('verified')}${result.model} · ${result.choice} · ${result.latencyMs}ms` }
            : { tone: 'bad', text: `${t('verifyFailed')}${result.code}` },
        );
        await onChanged?.();
        if (mounted.current) setBusy('');
        return result;
      };

      const enable = async () => {
        setBusy('enable');
        setMessage(null);
        let result;
        try {
          result = await call('/enable-enforce', { method: 'POST', body: '{}' });
        } catch (error) {
          result = { ok: false, enabled: false, code: String(error?.message ?? error) };
        }
        setMessage(
          result.enabled
            ? { tone: 'ok', text: `${t('enabled')} ${t('verified')}${result.verified?.model ?? ''} · ${result.verified?.latencyMs ?? 0}ms` }
            : { tone: 'bad', text: `${t('verifyFailed')}${result.code}` },
        );
        await onChanged?.();
        if (mounted.current) setBusy('');
        return result;
      };

      return {
        draft,
        setDraft,
        busy,
        message,
        setMessage,
        save,
        remove,
        verify,
        enable,
        keyConfigured,
        writable,
        provider,
        keyRef,
      };
    }

    /** The key field plus its actions, shared by both surfaces. */
    function KeyForm({ t, form }) {
      return h(
        'div',
        { className: 'jev-field' },
        h('span', { className: 'jev-label' }, t('keyLabel')),
        h('input', {
          className: 'jev-input',
          type: 'password',
          autoComplete: 'new-password',
          spellCheck: false,
          value: form.draft,
          placeholder: form.keyConfigured ? t('keyPlaceholderStored') : t('keyPlaceholderEmpty'),
          'aria-label': t('keyAria'),
          'aria-invalid': form.message?.tone === 'bad',
          disabled: form.busy !== '' || !form.writable || !form.provider,
          onChange: event => form.setDraft(event.target.value),
        }),
        h('span', { className: 'jev-hint' }, t('keyHint')),
        h('span', { className: 'jev-hint' }, `${t('keyScope')}: ${form.keyRef}`),
        // One explanation, never two: without a provider the writability of a
        // source is not the useful fact, and saying both reads as a contradiction.
        form.provider ? null : h('span', { className: 'jev-hint' }, t('noProvider')),
        form.provider && !form.writable ? h('span', { className: 'jev-hint' }, t('keyWritableNo')) : null,
        h(
          'div',
          { className: 'jev-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'jev-btn jev-btn-primary',
              disabled: form.busy !== '' || !form.provider || !form.writable,
              onClick: () => void form.save(),
            },
            form.busy === 'save' ? t('working') : t('save'),
          ),
          h(
            'button',
            { type: 'button', className: 'jev-btn', disabled: form.busy !== '' || !form.provider || !form.keyConfigured, onClick: () => void form.remove() },
            form.busy === 'remove' ? t('working') : t('remove'),
          ),
          h(
            'button',
            { type: 'button', className: 'jev-btn', disabled: form.busy !== '' || !form.provider || !form.keyConfigured, onClick: () => void form.verify() },
            form.busy === 'verify' ? t('verifying') : t('verify'),
          ),
        ),
      );
    }

    /** The three-way mode choice plus the one-gesture enforcement switch. */
    function ModeChoices({ t, status, busy, onSelect, onEnable }) {
      return h(
        'div',
        { className: 'jev-field' },
        h('span', { className: 'jev-label' }, t('modeLabel')),
        h(
          'div',
          { className: 'jev-choices' },
          ...['off', 'shadow', 'enforce'].map(mode =>
            h(
              'label',
              { key: mode, className: 'jev-choice' },
              h('input', {
                type: 'radio',
                name: 'jev-mode',
                value: mode,
                checked: status?.mode === mode,
                disabled: busy !== '' || !status,
                onChange: () => void onSelect(mode),
              }),
              h('span', null, `${mode} — ${t(mode === 'off' ? 'modeOffHint' : mode === 'shadow' ? 'modeShadowHint' : 'modeEnforceHint')}`),
            ),
          ),
        ),
        h(
          'div',
          { className: 'jev-row' },
          h(
            'button',
            {
              type: 'button',
              className: 'jev-btn jev-btn-primary',
              disabled: busy !== '' || !status?.keyConfigured || status?.mode === 'enforce',
              onClick: () => void onEnable(),
            },
            busy === 'enable' ? t('enabling') : t('enableEnforce'),
          ),
        ),
        status?.keyConfigured ? null : h('span', { className: 'jev-hint' }, t('enableNeedsKey')),
      );
    }

    /** Preset call budgets offered by the settings surface. */
    const BUDGET_PRESETS = [12, 24, 48];
    /** Accepted custom range, matching the plugin's Config schema. */
    const BUDGET_MIN = 1;
    const BUDGET_MAX = 100;

    /**
     * Call-budget editor.
     *
     * Presets plus a validated custom value. The effective value always comes
     * back from the Host, so what is shown is what will be used, and the task's
     * existing spend is shown beside it because changing a budget never resets
     * it.
     */
    function BudgetEditor({ t, status, onApply }) {
      const [custom, setCustom] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const current = status?.callBudget ?? null;
      const customMode = current !== null && !BUDGET_PRESETS.includes(current);

      const apply = async value => {
        setBusy(true);
        setMessage(null);
        try {
          const result = await onApply({ callBudget: value });
          setMessage(
            result?.ok
              ? { tone: 'ok', text: t('budgetApplied').replace('{n}', String(result.callBudget)) }
              : { tone: 'bad', text: t('budgetInvalid') },
          );
          if (result?.ok) setCustom('');
        } catch {
          setMessage({ tone: 'bad', text: t('failed') });
        } finally {
          setBusy(false);
        }
      };

      const applyCustom = async () => {
        const value = Number(custom.trim());
        if (!Number.isSafeInteger(value) || value < BUDGET_MIN || value > BUDGET_MAX) {
          setMessage({ tone: 'warn', text: t('budgetInvalid') });
          return;
        }
        await apply(value);
      };

      return h(
        'div',
        { className: 'jev-field' },
        h('span', { className: 'jev-label' }, t('budget')),
        h(
          'div',
          { className: 'jev-choices' },
          ...BUDGET_PRESETS.map(preset =>
            h(
              'label',
              { key: preset, className: 'jev-choice' },
              h('input', {
                type: 'radio',
                name: 'jev-budget',
                value: String(preset),
                checked: current === preset,
                disabled: busy || !status,
                onChange: () => void apply(preset),
              }),
              h('span', null, t('budgetPreset').replace('{n}', String(preset))),
            ),
          ),
          h(
            'label',
            { className: 'jev-choice' },
            h('input', {
              type: 'radio',
              name: 'jev-budget',
              value: 'custom',
              checked: customMode,
              disabled: busy || !status,
              onChange: () => setCustom(String(current ?? '')),
            }),
            h('span', null, customMode ? `${t('budgetCustom')}: ${current}` : t('budgetCustom')),
          ),
        ),
        h(
          'div',
          { className: 'jev-row' },
          h('input', {
            className: 'jev-input',
            type: 'text',
            inputMode: 'numeric',
            'aria-label': t('budgetCustomLabel'),
            placeholder: t('budgetCustomLabel'),
            value: custom,
            disabled: busy || !status,
            onChange: event => setCustom(event.target.value),
            style: { maxWidth: '120px' },
          }),
          h(
            'button',
            { type: 'button', className: 'jev-btn', disabled: busy || !status || custom.trim() === '', onClick: () => void applyCustom() },
            busy ? t('working') : t('save'),
          ),
        ),
        h('span', { className: 'jev-hint' }, t('budgetHint')),
        status
          ? h(
              'span',
              { className: 'jev-hint' },
              `${t('budgetUsed').replace('{used}', String(status.callsUsed ?? status.calls ?? 0)).replace('{limit}', String(current ?? '-'))} · ${
                status.accounting === 'goal' ? t('accountingGoal') : t('accountingSession')
              }`,
            )
          : null,
        h('span', { className: 'jev-hint' }, t('budgetKeepsCounts')),
        message ? h('div', { className: 'jev-msg', 'data-tone': message.tone, role: 'status' }, message.text) : null,
      );
    }

    /**
     * Advanced settings: the intervention limit, which is independent of the
     * call budget and keeps its own default.
     */
    function AdvancedBudget({ t, status, onApply }) {
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const current = status?.interventionLimit ?? null;

      const apply = async () => {
        const value = Number(draft.trim());
        if (!Number.isSafeInteger(value) || value < 0 || value > 10) {
          setMessage({ tone: 'warn', text: t('budgetInvalid') });
          return;
        }
        setBusy(true);
        setMessage(null);
        try {
          const result = await onApply({ interventionLimit: value });
          setMessage(
            result?.ok
              ? { tone: 'ok', text: t('interventionApplied').replace('{n}', String(result.interventionLimit)) }
              : { tone: 'bad', text: t('budgetInvalid') },
          );
          setDraft('');
        } catch {
          setMessage({ tone: 'bad', text: t('failed') });
        } finally {
          setBusy(false);
        }
      };

      return h(
        'details',
        { className: 'jev-advanced' },
        h('summary', null, t('advanced')),
        h(
          'div',
          { className: 'jev-field' },
          h('span', { className: 'jev-label' }, `${t('interventionLabel')}${current === null ? '' : `: ${current}`}`),
          h(
            'div',
            { className: 'jev-row' },
            h('input', {
              className: 'jev-input',
              type: 'text',
              inputMode: 'numeric',
              'aria-label': t('interventionLabel'),
              placeholder: '0–10',
              value: draft,
              disabled: busy || !status,
              onChange: event => setDraft(event.target.value),
              style: { maxWidth: '120px' },
            }),
            h(
              'button',
              { type: 'button', className: 'jev-btn', disabled: busy || !status || draft.trim() === '', onClick: () => void apply() },
              busy ? t('working') : t('save'),
            ),
          ),
          h('span', { className: 'jev-hint' }, t('interventionHint')),
          message ? h('div', { className: 'jev-msg', 'data-tone': message.tone, role: 'status' }, message.text) : null,
        ),
      );
    }

    /**
     * Short status row. Connection and supervision are rendered as two
     * independent facts with a separator, so a working connection never reads as
     * "this task is still protected".
     */
    function StatusRow({ t, status }) {
      const connection = dotState(status);
      const connectionLabel = t(CONNECTION_KEYS[connection] ?? 'unknown');
      const supervision = status?.supervision ?? 'unverified';
      const supervisionLabel = t(SUPERVISION_KEYS[supervision] ?? 'svUnverified');
      const limitLabel = status?.limit && LIMIT_KEYS[status.limit] ? ` (${t(LIMIT_KEYS[status.limit])})` : '';
      return h(
        'span',
        { className: 'jev-row' },
        h('span', { className: 'jev-dot', 'data-state': connection, 'aria-hidden': true }),
        h('span', null, connectionLabel),
        h('span', { className: 'jev-sep', 'aria-hidden': true }, '·'),
        h('span', { className: 'jev-sv', 'data-state': supervision }, h('span', null, `${supervisionLabel}${limitLabel}`)),
      );
    }

    /**
     * Composer-dock controls: title, mode, connection, details, refresh.
     * Deliberately short — the long explanation lives in the settings section.
     */
    function DockControls(props) {
      const { locale, t: translate, sessionId } = props ?? {};
      useLocaleRevision(locale);
      const t = key => translator(locale, translate, key);
      const { status, error, load } = useStatus({ sessionId });
      const [busy, setBusy] = React.useState(false);
      const [expanded, setExpanded] = React.useState(false);
      const mounted = React.useRef(true);

      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      const changeMode = async value => {
        setBusy(true);
        try {
          await call('/mode', { method: 'POST', body: JSON.stringify({ mode: value }) });
          await load();
        } catch {
          // A failed switch leaves the previous mode in place; the refresh below
          // shows what the Host actually holds.
        } finally {
          if (mounted.current) setBusy(false);
        }
      };

      const resume = async () => {
        setBusy(true);
        try {
          await call('/resume', { method: 'POST', body: '{}' });
          await load();
        } catch {
          /* see changeMode */
        } finally {
          if (mounted.current) setBusy(false);
        }
      };


      return h(
        'div',
        { className: 'jev-dock' },
        h('strong', null, t('title')),
        h(
          'select',
          {
            className: 'jev-select',
            'aria-label': t('modeLabel'),
            value: status?.mode ?? '',
            disabled: busy || !status,
            onChange: event => void changeMode(event.target.value),
          },
          status ? null : h('option', { value: '' }, '…'),
          ...['off', 'shadow', 'enforce'].map(mode => h('option', { key: mode, value: mode }, `${t('mode')}: ${mode}`)),
        ),
        h(StatusRow, { t, status }),
        status?.paused
          ? h('button', { type: 'button', className: 'jev-btn', disabled: busy, onClick: () => void resume() }, t('resume'))
          : null,
        h(
          'button',
          {
            type: 'button',
            className: 'jev-btn jev-btn-quiet',
            'aria-expanded': expanded,
            onClick: () => setExpanded(value => !value),
          },
          `${expanded ? '▾' : '▸'} ${t('details')}`,
        ),
        h('button', { type: 'button', className: 'jev-btn', disabled: busy, onClick: () => void load() }, t('refresh')),
        // The details line stays to what the user asked to see: how many
        // judgement calls and interventions this task has left. Counting scope,
        // settings store and model are deliberately not shown here; the settings
        // page is where the budget itself is configured.
        expanded && status
          ? h(
              'span',
              { className: 'jev-detail' },
              `${status.callsUsed ?? status.calls}/${status.callBudget} ${t('calls')} · ${
                status.interventionsUsed ?? status.interventions
              }/${status.interventionLimit} ${t('interventions')}`,
            )
          : null,
        !status || status.keyConfigured ? null : h('span', { className: 'jev-detail' }, t('goSettings')),
        error ? h('span', { className: 'jev-msg', 'data-tone': 'bad', role: 'alert' }, t('failed')) : null,
      );
    }

    /**
     * Settings section: status, the key form, the connection check, the mode
     * choices and the diagnostics tail.
     */
    function SettingsSection(props) {
      const { locale, t: translate, remote, sessionId } = props ?? {};
      useLocaleRevision(locale);
      const t = key => translator(locale, translate, key);
      const awaitingProvider = React.useCallback(
        current => current !== null && current?.credentialProvider === false,
        [],
      );
      const { status, load } = useStatus({ sessionId, intervalMs: 0, until: awaitingProvider });
      const form = useCredentialForm({ remote, status, t, onChanged: load });
      const [modeBusy, setModeBusy] = React.useState('');

      const selectMode = async value => {
        setModeBusy('mode');
        try {
          await call('/mode', { method: 'POST', body: JSON.stringify({ mode: value }) });
          await load();
        } catch {
          form.setMessage({ tone: 'bad', text: t('failed') });
        } finally {
          setModeBusy('');
        }
      };

      /**
       * Apply a budget change and re-read the Host's effective values.
       * The counters are not touched, so the spend shown afterwards is the same
       * spend the task had before the change.
       */
      const applyBudget = async patch => {
        const response = await call('/mode', { method: 'POST', body: JSON.stringify(patch) });
        await load();
        return response;
      };

      const diagnostics = (status?.details ?? [])
        .slice(-5)
        .map(entry => `${entry.time} ${entry.kind} ${entry.action ?? ''} ${entry.reason ?? ''}`.trim())
        .join('\n');

      return h(
        'div',
        { className: 'jev-sec' },
        h('h2', null, t('nav')),
        h('p', null, t('intro')),
        h('p', null, t('disclosure')),
        status ? h(StatusRow, { t, status }) : null,
        h(KeyForm, { t, form }),
        h('hr', { className: 'jev-hr' }),
        h(ModeChoices, { t, status, busy: modeBusy, onSelect: selectMode, onEnable: () => void form.enable() }),
        h('hr', { className: 'jev-hr' }),
        h(BudgetEditor, { t, status, onApply: applyBudget }),
        h(AdvancedBudget, { t, status, onApply: applyBudget }),
        status
          ? h(
              'p',
              null,
              `${t('budgetUsed').replace('{used}', String(status.callsUsed ?? status.calls ?? 0)).replace('{limit}', String(status.callBudget ?? '-'))} · ${
                status.interventionsUsed ?? status.interventions
              }/${status.interventionLimit} ${t('interventions')} · ${t('budgetCounting')}: ${
                status.accounting === 'goal' ? t('accountingGoal') : t('accountingSession')
              } · ${t('store')}: ${status.store} · ${status.model}`,
            )
          : null,
        form.message ? h('div', { className: 'jev-msg', 'data-tone': form.message.tone, role: 'status' }, form.message.text) : null,
        diagnostics
          ? h('div', { className: 'jev-field' }, h('span', { className: 'jev-label' }, t('diagnostics')), h('div', { className: 'jev-kv' }, diagnostics))
          : null,
        h('span', { className: 'jev-hint' }, t('uninstall')),
      );
    }

    /**
     * First-run setup panel.
     *
     * Shown once, and only while no key is configured: a user who already has a
     * key is never asked again, and after "later" the panel stays closed because
     * the Host stores that decision. Cancelling changes no mode and no budget.
     * It renders in the official `shell.overlay` list slot as a modal built from
     * the plugin's own controls, and the same operations are always available in
     * Settings → Jev Supervisor.
     */
    function SetupPanel(props) {
      const { locale, t: translate, remote, sessionId } = props ?? {};
      useLocaleRevision(locale);
      const t = key => translator(locale, translate, key);
      const { status, load } = useStatus({ sessionId, intervalMs: 0 });
      const form = useCredentialForm({ remote, status, t, onChanged: load });
      const [closed, setClosed] = React.useState(false);
      const [shown, setShown] = React.useState(false);

      React.useEffect(() => {
        // Give the page a moment to settle, and never appear without a settled
        // status answer.
        if (status === null) return undefined;
        if (status.keyConfigured || status.onboarded) return undefined;
        const timer = setTimeout(() => setShown(true), 1200);
        return () => clearTimeout(timer);
      }, [status]);

      const dismiss = async () => {
        setClosed(true);
        try {
          await call('/onboarding', { method: 'POST', body: JSON.stringify({ onboarded: true }) });
        } catch {
          // A failed dismissal leaves the flag unset; the panel stays closable.
        }
        await load();
      };

      if (closed || !shown || !status || status.keyConfigured || status.onboarded) return null;

      return h(
        'div',
        {
          className: 'jev-mask',
          role: 'presentation',
          onClick: event => {
            if (event.target === event.currentTarget) void dismiss();
          },
        },
        h(
          'div',
          {
            className: 'jev-panel',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('setupAria'),
            tabIndex: -1,
            onKeyDown: event => {
              if (event.key === 'Escape') void dismiss();
            },
          },
          h(
            'div',
            { className: 'jev-panel-head' },
            h('h2', null, t('setupTitle')),
            h('button', { type: 'button', className: 'jev-x', 'aria-label': t('setupClose'), onClick: () => void dismiss() }, '\u2715'),
          ),
          h(
            'div',
            { className: 'jev-panel-body' },
            h('p', null, t('setupIntro')),
            h('span', { className: 'jev-steps' }, t('setupSteps')),
            h(KeyForm, { t, form }),
            h('hr', { className: 'jev-hr' }),
            // The budget is part of the first-run decision too, so a new install
            // starts from a visible, chosen value instead of a hidden default.
            h(BudgetEditor, {
              t,
              status,
              onApply: async patch => {
                const response = await call('/mode', { method: 'POST', body: JSON.stringify(patch) });
                await load();
                return response;
              },
            }),
            h(ModeChoices, { t, status, busy: form.busy, onSelect: () => {}, onEnable: () => void form.enable() }),
            h('span', { className: 'jev-hint' }, t('setupNoKey')),
            form.message ? h('div', { className: 'jev-msg', 'data-tone': form.message.tone, role: 'status' }, form.message.text) : null,
          ),
          h(
            'div',
            { className: 'jev-panel-foot' },
            h('button', { type: 'button', className: 'jev-btn', onClick: () => void dismiss() }, t('setupLater')),
            status.mode === 'enforce'
              ? h('button', { type: 'button', className: 'jev-btn jev-btn-primary', onClick: () => void dismiss() }, t('setupDone'))
              : null,
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.credentials'],
      apply(ctx) {
        const slots = ctx.slots;
        if (slots === undefined || typeof slots.inject !== 'function') return;

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`);

        /**
         * Every surface is handed the credential Remote. Session-scoped surfaces
         * also pass the session id they render for, so the status they read is
         * that session's supervision state.
         */
        const shares = sessionId => ({ remote: ctx.remote, sessionId });

        slots.inject('conversation.composer.dock', () =>
          slots.register(
            {
              name: 'conversation.composer.dock',
              id: `${NS}-controls`,
              order: 20,
              locale: NS,
              // The dock is rendered per session; carrying that id keeps the
              // status it reads scoped to the session the user is looking at.
              inject: sessionId => shares(sessionId),
            },
            DockControls,
          ),
        );

        slots.inject('settings.section', () =>
          slots.register(
            {
              name: 'settings.section',
              id: NS,
              order: 40,
              label: () => ctx.locale.bind(NS)('nav'),
              locale: NS,
              inject: () => shares(undefined),
            },
            SettingsSection,
          ),
        );

        // The first-run panel is a list entry in the official overlay slot, so it
        // lives inside the app shell rather than a second document.
        slots.inject('shell.overlay', () =>
          slots.register(
            {
              name: 'shell.overlay',
              id: `${NS}.setup`,
              order: 30,
              locale: NS,
              inject: () => shares(undefined),
            },
            SetupPanel,
          ),
        );
      },
    };
  },
});
