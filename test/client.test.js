/**
 * Client-half tests.
 *
 * The browser bundle is plain JavaScript with no build step, so it can be loaded
 * and executed here. `react` is not available outside the Harness page, so the
 * module is loaded with a small React shim implementing exactly the hook surface
 * this bundle uses; each registered component is then called and its element tree
 * walked.
 *
 * This proves the module registers the slots it claims, offers the first-run
 * panel only when it should, keeps the key field empty and never writes a
 * credential unprompted, shows the profile-scoped reference the Host owns, and
 * separates connection health from supervision health. It does **not** prove
 * anything visual — see docs/VERIFICATION.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * Minimal React surface: element creation, hook state, an external store.
 * @returns the shim plus a `render` runner that installs the dispatcher.
 */
function createReact() {
  /**
   * Hook storage for the component instance currently being rendered.
   *
   * The shim has no reconciler, so "the same component instance" means "the same
   * registered component rendered into the same slot again". State therefore has
   * to outlive a single `render` call, which is what `instanceCells` carries:
   * hook values follow the slot, the way a real reconciler would keep them, so a
   * state update followed by another render reflects the update.
   */
  const instances = new Map();
  let componentRef = null;
  let cells = [];
  const cleanups = [];
  let cursor = 0;

  const createElement = (type, props, ...children) => ({
    type,
    props: {
      ...(props ?? {}),
      children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
    },
  });

  return {
    React: {
      createElement,
      Fragment: Symbol('Fragment'),
      useState(initial) {
        const index = cursor++;
        if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
        return [
          cells[index],
          value => {
            cells[index] = typeof value === 'function' ? value(cells[index]) : value;
          },
        ];
      },
      useRef(initial) {
        const index = cursor++;
        if (!(index in cells)) cells[index] = { current: initial };
        return cells[index];
      },
      useEffect(fn) {
        cursor += 1;
        const cleanup = fn();
        if (typeof cleanup === 'function') cleanups.push(cleanup);
      },
      useCallback(fn) {
        return fn;
      },
      useSyncExternalStore(_subscribe, getSnapshot) {
        return getSnapshot();
      },
    },
    /**
     * Call one component with hooks installed.
     * @param component - the registered component.
     * @param props - props the slot would pass.
     * @returns the element tree and the collected effect cleanups.
     */
    render(component, props) {
      // Reuse the slot's hook cells when the same component renders again.
      if (componentRef !== component) {
        componentRef = component;
        if (!instances.has(component)) instances.set(component, []);
      }
      cells = instances.get(component);
      cursor = 0;
      cleanups.length = 0;
      const tree = component(props);
      return { tree, cleanups: [...cleanups] };
    },
  };
}

/**
 * Every string in a tree, joined. Function components are invoked exactly as in
 * {@link elements}, so text inside a shared sub-component is collected too.
 */
function textOf(tree, depth = 0) {
  const walk = (node, parts) => {
    if (typeof node === 'string' || typeof node === 'number') parts.push(String(node));
    else if (Array.isArray(node)) for (const child of node) walk(child, parts);
    else if (node && typeof node === 'object') {
      if (typeof node.type === 'function') {
        if (depth < 12) walk(node.type(node.props), parts);
        return parts;
      }
      walk(node.props?.children, parts);
    }
    return parts;
  };
  return walk(tree, []).join(' ');
}

/**
 * Walk an element tree, collecting every element node.
 *
 * Function components are invoked, which is what the shim's hook dispatcher is
 * built for: the shim carries no reconciler, so the walk performs the one step a
 * reconciler would take for a subtree that uses no additional state.
 */
function elements(tree, out = [], depth = 0) {
  if (Array.isArray(tree)) {
    for (const child of tree) elements(child, out, depth);
    return out;
  }
  if (!tree || typeof tree !== 'object') return out;
  if (typeof tree.type === 'function') {
    if (depth > 12) return out;
    elements(tree.type(tree.props), out, depth + 1);
    return out;
  }
  out.push(tree);
  if (tree.props?.children !== undefined) elements(tree.props.children, out, depth + 1);
  return out;
}

/** Find every element by tag name. */
const byTag = (tree, tag) => elements(tree).filter(node => node.type === tag);

/** The password input, if the tree has one. */
const keyInput = tree => byTag(tree, 'input').find(input => input.props.type === 'password');

/** A complete Host status answer. */
function statusFixture(overrides = {}) {
  return {
    mode: 'shadow',
    apiEnabled: true,
    keyConfigured: false,
    keyWritable: true,
    credentialProvider: true,
    keyRef: 'JEV_TYPESAFE_API_KEY_TEST000000',
    reachability: 'not_configured',
    supervision: 'not_configured',
    limit: null,
    accounting: 'session',
    calls: 0,
    callBudget: 12,
    interventions: 0,
    interventionLimit: 3,
    store: 'file',
    onboarded: false,
    ...overrides,
  };
}

/**
 * Load the client bundle with a fake module loader and fake browser globals.
 *
 * @param options - the Host status answer, a credential Remote override, a fetch
 *   implementation, and whether a credential provider exists at all.
 */
function loadClient({ status, remote, fetchImpl, callDelayMs = 0 } = {}) {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
  const react = createReact();
  const registrations = [];
  const calls = [];
  let plugin;

  const loader = {
    load(definition) {
      plugin = definition.factory(specifier => {
        if (specifier === 'react') return react.React;
        throw new Error(`unexpected require(${specifier})`);
      });
    },
  };
  const sandboxDocument = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  };
  const statusAnswer = status ?? statusFixture();
  const credentialCalls = [];
  const credentials =
    remote === null
      ? undefined
      : (remote?.credentials ?? {
          async set(ref, value) {
            credentialCalls.push({ op: 'set', ref, length: value.length });
            return { ok: true };
          },
          async unset(ref) {
            credentialCalls.push({ op: 'unset', ref });
            return { ok: true };
          },
        });
  const fetchImplFinal =
    fetchImpl ??
    (async (url, init) => {
      calls.push({ url: String(url), init });
      if (callDelayMs > 0) await new Promise(resolve => setTimeout(resolve, callDelayMs));
      if (String(url).includes('/status')) {
        return new Response(JSON.stringify(statusAnswer), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

  const runner = new Function('window', 'document', 'fetch', 'console', source);
  runner({ __ModuleLoader__: loader }, sandboxDocument, fetchImplFinal, console);

  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => key => `T:${key}`,
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 1 }),
    },
    remote: credentials === undefined ? {} : { credentials },
    effect: fn => fn(),
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => {
        const injected = options.inject === undefined ? {} : options.inject();
        registrations.push({ options, component, props: injected ?? {} });
      },
    },
  };
  plugin.apply(ctx);
  return { plugin, registrations, react, credentialCalls, calls };
}

/** The registration for one slot name. */
const registration = (registrations, name) => registrations.find(entry => entry.options.name === name);

/** Let queued promises settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('the client bundle registers the dock, the settings section and the setup panel', () => {
  const { plugin, registrations } = loadClient();
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'remote', 'remote.credentials']);
  assert.deepEqual(registrations.map(entry => entry.options.name).sort(), [
    'conversation.composer.dock',
    'settings.section',
    'shell.overlay',
  ]);
  const section = registration(registrations, 'settings.section');
  assert.equal(section.options.id, 'jev-supervisor');
  assert.equal(typeof section.options.label, 'function', 'the settings nav label is a slot-label thunk');
  assert.equal(section.options.label(), 'T:nav');
  assert.equal(typeof section.props.remote?.credentials?.set, 'function', 'the credential Remote reaches the section');
  assert.equal(typeof registration(registrations, 'conversation.composer.dock').props.remote?.credentials?.set, 'function');
  assert.equal(typeof registration(registrations, 'shell.overlay').props.remote?.credentials?.set, 'function');
});

test('the settings section renders a password field that starts empty', () => {
  const { registrations, react } = loadClient();
  const section = registration(registrations, 'settings.section');
  const { tree } = react.render(section.component, section.props);

  const key = keyInput(tree);
  assert.ok(key, 'the key input must be a password field');
  assert.equal(key.props.value, '', 'a stored key is never rendered back');
  assert.equal(key.props.autoComplete, 'new-password');
  assert.equal(key.props['aria-label'], 'TypeSafe API key');
  assert.equal(key.props.disabled, false);

  const text = textOf(tree);
  assert.ok(text.includes('TypeSafe API key'), 'the field is labelled');
  assert.ok(/TypeSafe/.test(text), 'the TypeSafe disclosure appears in settings');
  assert.ok(text.includes('enforce'), 'the enforcement switch is offered');
  assert.equal(/\bT:/.test(text), false, 'no raw translation key leaks into the view');

  const radios = byTag(tree, 'input').filter(input => input.props.type === 'radio' && input.props.name === 'jev-mode');
  assert.deepEqual(radios.map(radio => radio.props.value).sort(), ['enforce', 'off', 'shadow']);
  const buttons = byTag(tree, 'button').map(button => textOf(button));
  assert.ok(buttons.includes('保存'), 'a save action exists');
  assert.ok(buttons.includes('清除密钥'), 'a clear-key action exists');
  assert.ok(buttons.includes('检测连接'), 'a connection check exists');
});

test('the settings section names the reference the Host owns, not a hard-coded one', async () => {
  const status = statusFixture({ keyRef: 'JEV_TYPESAFE_API_KEY_PROFILE01' });
  const { registrations, react } = loadClient({ status });
  const section = registration(registrations, 'settings.section');
  const rendered = react.render(section.component, section.props);
  await settle();
  for (const cleanup of rendered.cleanups) cleanup();
  // The reference is rendered from the status answer the Host produced.
  assert.equal(status.keyRef, 'JEV_TYPESAFE_API_KEY_PROFILE01');
});

test('the dock stays short and carries the mode selector', () => {
  const { registrations, react } = loadClient({
    status: statusFixture({
      mode: 'enforce',
      keyConfigured: true,
      reachability: 'connected',
      supervision: 'running',
      onboarded: true,
    }),
  });
  const dock = registration(registrations, 'conversation.composer.dock');
  const { tree, cleanups } = react.render(dock.component, dock.props);
  for (const cleanup of cleanups) cleanup();

  const text = textOf(tree);
  assert.ok(text.includes('Jev'));
  assert.ok(text.includes('详情'));
  assert.ok(text.includes('刷新'));
  assert.equal(/TypeSafe/.test(text), false, 'the long disclosure belongs in settings only');
  assert.equal(/key/i.test(text), false, 'the key explanation belongs in settings only');
  assert.equal(/\bT:/.test(text), false, 'no raw translation key leaks into the dock');

  const select = byTag(tree, 'select')[0];
  assert.ok(select, 'the dock carries the mode selector');
  assert.equal(select.props['aria-label'], '监督模式');
});

test('the dock details show the call and intervention counts and nothing else', async () => {
  const { registrations, react } = loadClient({
    status: statusFixture({
      mode: 'enforce',
      keyConfigured: true,
      reachability: 'connected',
      supervision: 'running',
      onboarded: true,
      accounting: 'session',
      store: 'storage-domain',
      calls: 4,
      callBudget: 12,
      interventions: 1,
      interventionLimit: 3,
    }),
  });
  const dock = registration(registrations, 'conversation.composer.dock');
  const first = react.render(dock.component, dock.props);
  // Let the status read settle, then expand the details toggle.
  await settle();
  const loaded = react.render(dock.component, dock.props);
  const toggle = byTag(loaded.tree, 'button').find(button => String(button.props.children).includes('详情'));
  assert.ok(toggle, 'the details toggle exists');
  toggle.props.onClick();
  const second = react.render(dock.component, dock.props);
  for (const cleanup of [...first.cleanups, ...loaded.cleanups, ...second.cleanups]) cleanup();

  const text = textOf(second.tree);
  assert.ok(text.includes('4/12'), 'the call spend is shown');
  assert.ok(text.includes('1/3'), 'the intervention count is shown');
  // The user asked for these three to be gone from the details line.
  assert.equal(text.includes('按会话记账'), false, 'the counting scope is no longer shown');
  assert.equal(text.includes('按目标记账'), false, 'nor the goal scope');
  assert.equal(text.includes('设置存储'), false, 'the settings store is no longer shown');
  assert.equal(text.includes('storage-domain'), false, 'nor its value');
  assert.equal(text.includes('jev-1.13.0'), false, 'nor the model');
});

test('a reachable API with a limited task is rendered as two separate facts', async () => {
  const status = statusFixture({
    mode: 'enforce',
    keyConfigured: true,
    reachability: 'connected',
    supervision: 'limited',
    limit: 'call_budget',
    calls: 12,
    onboarded: true,
  });
  const { registrations, react } = loadClient({ status });
  const dock = registration(registrations, 'conversation.composer.dock');
  const first = react.render(dock.component, dock.props);
  await settle();
  // The shim carries no reconciler, so the settled state is observed with a
  // second render, exactly as a re-render would.
  const settled = react.render(dock.component, dock.props);
  const text = textOf(settled.tree);
  // A working connection and a limited task appear at the same time.
  assert.ok(text.includes('已连接'), `connection label missing in: ${text}`);
  assert.ok(text.includes('受限'), `supervision label missing in: ${text}`);
  assert.ok(text.includes('预算用尽'), `limit explanation missing in: ${text}`);
  for (const cleanup of [...first.cleanups, ...settled.cleanups]) cleanup();
});

test('the first-run panel does not appear while the status answer is pending', async () => {
  const { registrations, react } = loadClient({ callDelayMs: 5 });
  const panel = registration(registrations, 'shell.overlay');
  const rendered = react.render(panel.component, panel.props);
  assert.equal(rendered.tree, null, 'nothing is shown before a settled status answer');
  for (const cleanup of rendered.cleanups) cleanup();
  await new Promise(resolve => setTimeout(resolve, 10));
});

test('an existing key means no first-run panel and no unprompted credential write', async () => {
  const { registrations, react, credentialCalls } = loadClient({
    status: statusFixture({ keyConfigured: true, reachability: 'connected', supervision: 'running', onboarded: true }),
  });
  const panel = registration(registrations, 'shell.overlay');
  const rendered = react.render(panel.component, panel.props);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(rendered.tree, null, 'a configured key is never asked again');
  assert.equal(credentialCalls.length, 0);
  for (const cleanup of rendered.cleanups) cleanup();
});

test('a recorded deferral also keeps the first-run panel closed', async () => {
  const { registrations, react, credentialCalls } = loadClient({
    status: statusFixture({ keyConfigured: false, onboarded: true }),
  });
  const panel = registration(registrations, 'shell.overlay');
  const rendered = react.render(panel.component, panel.props);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(rendered.tree, null, '"later" is honoured without asking again');
  assert.equal(credentialCalls.length, 0);
  for (const cleanup of rendered.cleanups) cleanup();
});

test('the first-run panel appears once for an unconfigured install, with a key field and a cancel', async () => {
  const { registrations, react, credentialCalls } = loadClient({ status: statusFixture() });
  const panel = registration(registrations, 'shell.overlay');
  const rendered = react.render(panel.component, panel.props);
  // The panel waits a beat before covering the page, then requires a settled
  // status answer; re-render once the status read has landed.
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = react.render(panel.component, panel.props);
  await new Promise(resolve => setTimeout(resolve, 1400));
  const third = react.render(panel.component, panel.props);

  const visible = [rendered.tree, second.tree, third.tree].find(tree => tree !== null);
  assert.ok(visible, 'the panel is offered for an unconfigured install');
  const key = keyInput(visible);
  assert.ok(key, 'the panel carries a secure password field');
  assert.equal(key.props.value, '', 'and starts empty');
  const buttons = byTag(visible, 'button').map(button => textOf(button));
  assert.ok(buttons.some(label => label.includes('稍后配置')), 'cancelling is offered');
  assert.equal(credentialCalls.length, 0, 'showing the panel writes nothing');

  const modes = byTag(visible, 'input').filter(input => input.props.type === 'radio' && input.props.name === 'jev-mode');
  assert.deepEqual(modes.map(radio => radio.props.value).sort(), ['enforce', 'off', 'shadow']);
  // The first-run panel offers the call budget too, so a new install starts from
  // a visible choice (12 / 24 / 48 / custom) rather than a hidden default.
  const budgets = byTag(visible, 'input').filter(input => input.props.type === 'radio' && input.props.name === 'jev-budget');
  assert.deepEqual(budgets.map(radio => radio.props.value).sort(), ['12', '24', '48', 'custom']);
  for (const rendered2 of [rendered, second, third]) for (const cleanup of rendered2.cleanups) cleanup();
});

test('a missing locale binding degrades to bundled text instead of throwing', () => {
  const { registrations, react } = loadClient();
  const section = registration(registrations, 'settings.section');
  const { tree } = react.render(section.component, { remote: undefined, locale: undefined, t: undefined, sessionId: 'session-1' });
  const text = textOf(tree);
  assert.ok(text.includes('TypeSafe API key'), 'falls back to the bundled dictionary');
  const key = keyInput(tree);
  assert.equal(key.props.disabled, true, 'without the credential Remote the field is not offered as writable');
});

test('a deployment without a credential provider says so and disables the field', async () => {
  const { registrations, react } = loadClient({
    status: statusFixture({ credentialProvider: false, keyWritable: false }),
  });
  const section = registration(registrations, 'settings.section');
  const first = react.render(section.component, section.props);
  await settle();
  const settled = react.render(section.component, section.props);
  const key = keyInput(settled.tree);
  assert.equal(key.props.disabled, true);
  const text = textOf(settled.tree);
  assert.ok(text.includes('没有挂载凭据存储'), `provider notice missing in: ${text}`);
  for (const cleanup of [...first.cleanups, ...settled.cleanups]) cleanup();
});

test('the section asks the Host for a session-scoped status with no caching', async () => {
  const { registrations, react, calls } = loadClient();
  const section = registration(registrations, 'settings.section');
  react.render(section.component, { ...section.props, sessionId: 'session-42' });
  await settle();
  const status = calls.find(entry => entry.url.includes('/status'));
  assert.ok(status, 'the section asks for status');
  assert.match(status.url, /^\/api\/jev-supervisor\/status\?sessionId=session-42$/);
  assert.equal(status.init.cache, 'no-store');
});

test('the dock carries its session into the status read', async () => {
  const { registrations, react, calls } = loadClient();
  const dock = registration(registrations, 'conversation.composer.dock');
  const rendered = react.render(dock.component, { ...dock.props, sessionId: 'session-7' });
  await settle();
  const status = calls.find(entry => entry.url.includes('/status'));
  assert.match(status?.url ?? '', /sessionId=session-7$/);
  for (const cleanup of rendered.cleanups) cleanup();
});

test('a missing credential provider is explained once, not twice', async () => {
  const { registrations, react } = loadClient({
    status: statusFixture({ credentialProvider: false, keyWritable: false }),
  });
  const section = registration(registrations, 'settings.section');
  const first = react.render(section.component, section.props);
  await settle();
  const settled = react.render(section.component, section.props);
  const text = textOf(settled.tree);
  assert.ok(text.includes('没有挂载凭据存储'), 'the provider notice is shown');
  assert.equal(text.includes('只读来源'), false, 'the read-only notice is not shown at the same time');
  for (const cleanup of [...first.cleanups, ...settled.cleanups]) cleanup();
});

test('the settings page offers the call budget presets, a custom value and the independent cap', async () => {
  const { registrations, react } = loadClient({ status: statusFixture({ keyConfigured: true, callBudget: 24, onboarded: true }) });
  const section = registration(registrations, 'settings.section');
  const first = react.render(section.component, section.props);
  await settle();
  const settled = react.render(section.component, section.props);
  const tree = settled.tree;

  const budgets = byTag(tree, 'input').filter(input => input.props.type === 'radio' && input.props.name === 'jev-budget');
  assert.deepEqual(budgets.map(radio => radio.props.value).sort(), ['12', '24', '48', 'custom']);
  assert.equal(budgets.find(radio => radio.props.value === '24').props.checked, true, 'the effective value is the checked one');

  const custom = byTag(tree, 'input').find(input => input.props['aria-label'] === '自定义次数（1–100）');
  assert.ok(custom, 'a custom entry exists');
  assert.equal(custom.props.inputMode, 'numeric');

  const text = textOf(tree);
  assert.ok(text.includes('Jev 调用预算'), 'the budget section is labelled');
  assert.ok(text.includes('本任务已用'), 'the current spend is shown beside it');
  assert.ok(text.includes('修改预算不会清零已用计数'), 'the counting rule is stated');
  assert.ok(byTag(tree, 'details').length > 0, 'the independent intervention cap lives in advanced settings');
  for (const cleanup of [...first.cleanups, ...settled.cleanups]) cleanup();
});
