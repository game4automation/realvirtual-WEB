// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-web-component-registry.ts — the INSTANCE registry for `WebComponent`
 * script components (plan-210 §4.4 / §9 phase 2).
 *
 * Deliberately separate from the SCHEMA registry (`rv-component-registry.ts`,
 * which maps rv_extras component types to native TS engine classes): this
 * registry manages one `WebComponentInstance` per node path — a QuickJS
 * script context (`SdkComponent`) + its kernel adapter
 * (`RVScriptComponentAdapter`) + a teardown list.
 *
 * Core capability: **hot-reload without a GLB reload** —
 *
 * ```
 * reload(nodePath, jsCode):
 *   dispose old instance (auto-teardown register: host subscriptions
 *   unsubscribed, pending self.in/at events cancelled, VM handles released,
 *   adapter cleared+detached from the kernels)
 *   → mint new instance → runSetup → active from the next tick
 * ```
 *
 *  - **COLD state policy (default and only policy in v1):** a reload rebuilds
 *    the VM context — all closure state is gone, like a sim reset for this
 *    one component. WARM (snapshot + re-inject) is NOT implemented: closure
 *    state is not snapshottable across a VM rebuild (§10 "State-Drift bei
 *    WARM") — documented open point, plan: "Start COLD".
 *  - **Swap guard:** `reload()` (and `disposeInstance()`) issued WHILE the
 *    registry is inside `tickAll`/`lateTickAll`/`resetAll`/`onSignalAll`
 *    (e.g. from a host callback a guest call triggered) is DEFERRED and
 *    applied after the pass completes — a tick never runs against a
 *    half-disposed instance.
 *  - **Failure isolation (§4.4):** a setup failure or a failure in the FIRST
 *    tick disables the instance (`disable(reason)` + debug log); the rest of
 *    the scene keeps running. Later handler failures only log.
 *
 * The module also owns the §7 `WebComponent` rv_extras parsing
 * (`parseWebComponent`) and the scene wiring entry point
 * (`wireWebComponents`) — called by `web-component-plugin.ts` on
 * `onModelLoaded` (deliberately NOT integrated into rv-scene-loader.ts; the
 * one-line loader integration can follow later).
 */

import type { Object3D } from 'three';
import type { RVScriptHost } from './rv-script-host';
import type { SandboxError } from './rv-script-sandbox';
import { createSdkComponent, type SdkComponent } from '../sdk/rv-component-sdk';
import { RVScriptComponentAdapter } from '../sdk/rv-script-component-adapter';
import type { SdkEnvironment, SdkScriptComponentAccess, SdkScriptComponentInfo } from '../sdk/rv-sdk-self';
import { RV_MSG_HOOK, type SdkScheduler } from '../sdk/rv-script-hook';

// ─── §7 WebComponent parsing ────────────────────────────────────────────────

/** Reserved §7 field names of the `WebComponent` rv_extras entry. */
const WEB_COMPONENT_FIELDS = new Set([
  'Active', 'ApiVersion', 'Language', 'DesSafe', 'TypeId', 'Code',
]);

/** Defensively parsed `WebComponent` data (plan-210 §7). */
export interface ParsedWebComponent {
  /** `Active ?? true` — inactive components are parsed but never executed. */
  active: boolean;
  /** `ApiVersion ?? 1` — SDK contract version the code was written against. */
  apiVersion: number;
  /** `Language ?? 'js'` — stored code is always conservative JS. */
  language: string;
  /** `DesSafe ?? false` — author claim, checked by the DES lint. */
  desSafe: boolean;
  /** `TypeId ?? ''` — library/type identity for inspector + statistics. */
  typeId: string;
  /** `Code ?? ''` — empty code ⇒ no VM is created, the instance is inactive. */
  code: string;
  /**
   * `self.prop` bag (v1 shim): additional PRIMITIVE fields on the
   * `WebComponent` object beyond the reserved §7 keys. The schema-driven
   * plan-139 property layer replaces this in phase 4.
   */
  props: Record<string, number | string | boolean | null>;
}

/**
 * Defensive §7 parse of a raw `userData.realvirtual.WebComponent` value.
 * Returns null for non-object input; every field falls back per §7
 * (`Code ?? ''`, `ApiVersion ?? 1`, `DesSafe ?? false`, …).
 */
export function parseWebComponent(raw: unknown): ParsedWebComponent | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const props: Record<string, number | string | boolean | null> = {};
  for (const [key, value] of Object.entries(r)) {
    if (WEB_COMPONENT_FIELDS.has(key)) continue;
    if (value === null || typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      props[key] = value;
    }
  }
  return {
    active: r.Active !== false,
    apiVersion: typeof r.ApiVersion === 'number' && Number.isFinite(r.ApiVersion) ? r.ApiVersion : 1,
    language: typeof r.Language === 'string' && r.Language.length > 0 ? r.Language : 'js',
    desSafe: r.DesSafe === true,
    typeId: typeof r.TypeId === 'string' ? r.TypeId : '',
    code: typeof r.Code === 'string' ? r.Code : '',
    props,
  };
}

// ─── Instance ───────────────────────────────────────────────────────────────

/**
 * One script component instance bound to a node path. `adapter`/`component`
 * are null while the instance is INACTIVE (Active:false or empty code — no
 * VM exists then, §7). The teardown list is the instance-level auto-teardown
 * register: everything registered here runs exactly once on `dispose()`.
 */
export class WebComponentInstance {
  readonly nodePath: string;
  readonly node: Object3D;
  readonly meta: ParsedWebComponent;

  /** Kernel adapter (null while inactive). */
  adapter: RVScriptComponentAdapter | null = null;
  /** Sandboxed component (null while inactive). */
  component: SdkComponent | null = null;
  /** True once the first continuous tick completed without a handler error. */
  firstTickCompleted = false;
  /** Last `self.setState(...)` value (script→script `component(path).state`). */
  state = 'idle';
  /** Error raised via `self.raiseError` (null after `clearError`). */
  raisedError: { code: string; message: string } | null = null;

  private readonly teardowns: Array<() => void> = [];
  private disposedFlag = false;
  private disabledFlag = false;
  private disabledReasonValue: string | null = null;

  constructor(nodePath: string, node: Object3D, meta: ParsedWebComponent) {
    this.nodePath = nodePath;
    this.node = node;
    this.meta = meta;
  }

  /** True when a VM context exists and the instance has not been disposed. */
  get active(): boolean {
    return this.component !== null && !this.disposedFlag;
  }

  /** False when setup failed, the instance was disabled, or it was disposed. */
  get ok(): boolean {
    return this.active && !this.disabledFlag && this.component!.ok
      && !this.component!.ctx.isDisabled;
  }

  /** Structured setup failure (null when setup succeeded / no VM exists). */
  get error(): SandboxError | null {
    return this.component?.error ?? null;
  }

  get isDisposed(): boolean {
    return this.disposedFlag;
  }

  get isDisabled(): boolean {
    return this.disabledFlag || (this.component?.ctx.isDisabled ?? false);
  }

  get disabledReason(): string | null {
    return this.disabledReasonValue ?? this.component?.ctx.disabledReason ?? null;
  }

  /** Registers a teardown callback (runs once, LIFO, on dispose). */
  addTeardown(fn: () => void): void {
    if (this.disposedFlag) {
      try { fn(); } catch { /* best effort on late registration */ }
      return;
    }
    this.teardowns.push(fn);
  }

  /** Disables the instance — the scene keeps running without it (§4.4). */
  disable(reason: string): void {
    if (this.disabledFlag) return;
    this.disabledFlag = true;
    this.disabledReasonValue = reason;
    this.component?.disable(reason);
  }

  /**
   * Full auto-teardown: runs the teardown list (LIFO) — component dispose
   * (bridge: unsubscribe host subscriptions + cancel pending timers; context:
   * release retained VM handles) and adapter dispose (clear heap, detach).
   * Idempotent.
   */
  dispose(): void {
    if (this.disposedFlag) return;
    this.disposedFlag = true;
    for (let i = this.teardowns.length - 1; i >= 0; i--) {
      try { this.teardowns[i](); } catch (err) {
        console.warn(`[web-component:${this.nodePath}] teardown step failed:`, err);
      }
    }
    this.teardowns.length = 0;
  }
}

// ─── Registry ───────────────────────────────────────────────────────────────

/** Arguments the registry hands to the host-environment factory. */
export interface WebComponentEnvArgs {
  nodePath: string;
  nodeName: string;
  node: Object3D;
  /** `self.prop` bag from the parsed §7 data. */
  props: Record<string, number | string | boolean | null>;
  /** The instance adapter's scheduler — MUST be used as `env.scheduler`. */
  scheduler: SdkScheduler;
  /**
   * Auto-teardown hook for anything the factory itself registers host-side
   * (event listeners, fan-out shims, …). Runs on instance dispose.
   */
  addTeardown(fn: () => void): void;
}

/** Builds the `SdkEnvironment` one instance runs against (viewer wiring). */
export type WebComponentEnvFactory = (args: WebComponentEnvArgs) => SdkEnvironment;

export interface WebComponentRegistryOptions {
  /** The shared QuickJS host (one runtime, one context per instance). */
  host: RVScriptHost;
  /** Environment factory (live viewer wiring or test mocks). */
  buildEnv: WebComponentEnvFactory;
  /** Emits `component-reloaded` / `component-error` on the viewer event bus. */
  emit?: (
    event: 'component-reloaded' | 'component-error',
    data: { nodePath: string; code?: string; message?: string; cleared?: boolean },
  ) => void;
  /** Observes instance disables (HMI/debug surfacing). */
  onInstanceDisabled?: (nodePath: string, reason: string) => void;
  /** Per host→VM call deadline in ms (default: script-host default, 5 ms). */
  callDeadlineMs?: number;
}

/**
 * Instance registry: one `WebComponentInstance` per node path, hot-reload via
 * `reload()`, kernel driving via `tickAll`/`lateTickAll` (called by the
 * web-component plugin from the simulation loop's fixed-update hooks).
 */
export class RVWebComponentRegistry {
  private readonly opts: WebComponentRegistryOptions;
  private readonly instances = new Map<string, WebComponentInstance>();
  /** Swap guard: true while a tick pass iterates the instances. */
  private inPass = false;
  /** Reloads/disposals deferred by the swap guard (applied after the pass). */
  private readonly deferred: Array<() => void> = [];
  private disposed = false;

  constructor(opts: WebComponentRegistryOptions) {
    this.opts = opts;
  }

  get size(): number {
    return this.instances.size;
  }

  get(nodePath: string): WebComponentInstance | null {
    return this.instances.get(nodePath) ?? null;
  }

  list(): WebComponentInstance[] {
    return [...this.instances.values()];
  }

  /**
   * Live script components with their kernel adapters (plan-261 B4). This is
   * the access path the (private) DES snapshot pipeline uses to capture and
   * restore per-script guest state (`adapter.captureScriptState()` /
   * `restoreScriptState()`) — the `ScriptHookDispatcher` alone is a pure event
   * channel with no state introspection. Public + structural: only public
   * types cross the boundary. Inactive / disposed instances are skipped.
   */
  listScriptComponents(): Array<{ path: string; adapter: RVScriptComponentAdapter }> {
    const out: Array<{ path: string; adapter: RVScriptComponentAdapter }> = [];
    for (const inst of this.instances.values()) {
      if (inst.adapter && !inst.isDisposed) {
        out.push({ path: inst.nodePath, adapter: inst.adapter });
      }
    }
    return out;
  }

  /**
   * Creates (or replaces) the instance for `nodePath`. Inactive metas
   * (Active:false or empty code) are registered WITHOUT a VM — they become
   * reload targets for the phase-3 editor.
   */
  create(nodePath: string, node: Object3D, meta: ParsedWebComponent): WebComponentInstance {
    this.assertUsable('create');
    this.instances.get(nodePath)?.dispose();
    const inst = this.mint(nodePath, node, meta);
    this.instances.set(nodePath, inst);
    return inst;
  }

  /**
   * Hot-reload (§4.4): disposes the old instance completely (auto-teardown
   * register) and mints a fresh one from `jsCode` — COLD state, active from
   * the next tick. Deferred to the end of the pass when called mid-tick
   * (swap guard). Emits `component-reloaded`.
   */
  reload(nodePath: string, jsCode: string): void {
    this.assertUsable('reload');
    if (this.inPass) {
      this.deferred.push(() => this.reload(nodePath, jsCode));
      return;
    }
    const old = this.instances.get(nodePath);
    if (!old) {
      console.warn(`[web-component] reload('${nodePath}'): no instance registered for this path`);
      return;
    }
    const meta: ParsedWebComponent = { ...old.meta, code: jsCode };
    const node = old.node;
    old.dispose();
    const inst = this.mint(nodePath, node, meta);
    this.instances.set(nodePath, inst);
    this.opts.emit?.('component-reloaded', { nodePath });
  }

  /** Disposes and removes one instance (deferred while a pass runs). */
  disposeInstance(nodePath: string): void {
    if (this.disposed) return;
    if (this.inPass) {
      this.deferred.push(() => this.disposeInstance(nodePath));
      return;
    }
    const inst = this.instances.get(nodePath);
    if (!inst) return;
    inst.dispose();
    this.instances.delete(nodePath);
  }

  /** Continuous fixed tick for every active instance (+ deferred-notify flush). */
  tickAll(dt: number): void {
    this.pass((inst) => {
      inst.adapter?.tick(dt);
      if (!inst.firstTickCompleted && inst.ok) inst.firstTickCompleted = true;
      this.surfacePoisonDisable(inst);
    });
  }

  /** Late continuous pass (`continuous.lateFixedUpdate`). */
  lateTickAll(dt: number): void {
    this.pass((inst) => inst.adapter?.lateTick(dt));
  }

  /** Forwards a signal edge to every instance's optional `onSignal`. */
  onSignalAll(name: string, value: boolean | number): void {
    this.pass((inst) => inst.adapter?.onSignal(name, value));
  }

  /** Sim reset: clear timers, zero clocks, call optional `onReset()`. */
  resetAll(): void {
    this.pass((inst) => inst.adapter?.reset());
  }

  // ── Script→script messaging (phase 1b) ──────────────────────────────────

  /**
   * Deliver a message to the component at `toPath` — scheduled on the
   * TARGET's event list at its current time (FIFO tie-break), so delivery is
   * deterministic and identical in both kernels: the target's `onMessage`
   * runs on its next event dispatch, never re-entrant into the sender's tick.
   * Suffix path match as a convenience (same convention as node resolution).
   */
  sendMessage(fromPath: string, toPath: string, topic: string, data: unknown): boolean {
    const inst = this.instances.get(toPath) ?? this.findBySuffix(toPath);
    if (!inst?.adapter || inst.isDisposed || !inst.ok) return false;
    inst.adapter.scheduler.in(0, RV_MSG_HOOK, null, { topic, data, from: fromPath });
    return true;
  }

  /** Broadcast to every OTHER active script component. Returns receiver count. */
  broadcastMessage(fromPath: string, topic: string, data: unknown): number {
    let n = 0;
    for (const inst of this.instances.values()) {
      if (inst.nodePath === fromPath || !inst.adapter || inst.isDisposed || !inst.ok) continue;
      inst.adapter.scheduler.in(0, RV_MSG_HOOK, null, { topic, data, from: fromPath });
      n++;
    }
    return n;
  }

  /** Value snapshot of one component (script→script `component(path)`). */
  getInfo(path: string): SdkScriptComponentInfo | null {
    const inst = this.instances.get(path) ?? this.findBySuffix(path);
    if (!inst) return null;
    return {
      path: inst.nodePath,
      state: inst.state,
      enabled: inst.ok,
      error: inst.raisedError,
    };
  }

  /** The default `SdkEnvironment.scripts` backend for one instance. */
  private makeScriptAccess(selfPath: string): SdkScriptComponentAccess {
    return {
      get: (path) => this.getInfo(path),
      send: (toPath, topic, data) => this.sendMessage(selfPath, toPath, topic, data),
      broadcast: (topic, data) => this.broadcastMessage(selfPath, topic, data),
    };
  }

  /** Suffix path match (convenience — full hierarchy paths stay preferred). */
  private findBySuffix(path: string): WebComponentInstance | null {
    for (const inst of this.instances.values()) {
      if (inst.nodePath.endsWith(`/${path}`)) return inst;
    }
    return null;
  }

  /** Disposes every instance and the registry itself. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deferred.length = 0;
    for (const inst of this.instances.values()) inst.dispose();
    this.instances.clear();
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  /** Runs one guarded pass over all instances, then applies deferred ops. */
  private pass(fn: (inst: WebComponentInstance) => void): void {
    if (this.disposed || this.inPass) return;
    this.inPass = true;
    try {
      for (const inst of this.instances.values()) {
        fn(inst);
        // Deliver notifications deferred during the VM invocations above.
        inst.component?.bridge.flushDeferredNotifies();
      }
    } finally {
      this.inPass = false;
    }
    while (this.deferred.length > 0 && !this.disposed) {
      const op = this.deferred.shift()!;
      try { op(); } catch (err) {
        console.warn('[web-component] deferred registry op failed:', err);
      }
    }
  }

  /** Builds one instance: adapter → env → sandboxed component → attach. */
  private mint(nodePath: string, node: Object3D, meta: ParsedWebComponent): WebComponentInstance {
    const inst = new WebComponentInstance(nodePath, node, meta);
    if (!meta.active || meta.code.trim().length === 0) {
      return inst;   // §7: empty code / inactive → no VM, no error.
    }

    const adapter = new RVScriptComponentAdapter({
      onHandlerError: (path, message) => {
        // §4.4 failure isolation: an error in the FIRST tick disables the
        // instance; later handler errors only log (poison backoff decides
        // hard disables for deadline/memory aborts).
        if (!inst.firstTickCompleted) {
          const reason = `first-tick handler '${path}' failed: ${message}`;
          inst.disable(reason);
          this.opts.onInstanceDisabled?.(nodePath, reason);
        } else {
          console.warn(`[web-component:${nodePath}] handler '${path}' failed: ${message}`);
        }
      },
    });

    const env = this.opts.buildEnv({
      nodePath,
      nodeName: node.name || nodePath.split('/').pop() || nodePath,
      node,
      props: meta.props,
      scheduler: adapter.scheduler,
      addTeardown: (fn) => inst.addTeardown(fn),
    });

    // ── Registry defaults (phase 1b) — additive, factory overrides win ──
    // State tracking (script→script `component(path).state`): wrap the
    // factory's onSetState so the instance always mirrors the FSM state.
    const userOnSetState = env.onSetState;
    env.onSetState = (state: string): void => {
      inst.state = state;
      userOnSetState?.(state);
    };
    // Script→script access: message delivery through the TARGET's event list
    // (time = now, FIFO — deterministic in both kernels).
    env.scripts ??= this.makeScriptAccess(nodePath);
    // Error sink: instance error state + `component-error` viewer event +
    // conventional `<Name>.Error` bool signal (readable by neighbours/PLC).
    if (!env.errors) {
      const errorSignal = `${env.name}.Error`;
      const signals = env.signals;
      env.errors = {
        raise: (code, message) => {
          inst.raisedError = { code, message };
          signals?.set(errorSignal, true);
          this.opts.emit?.('component-error', { nodePath, code, message });
        },
        clear: () => {
          inst.raisedError = null;
          signals?.set(errorSignal, false);
          this.opts.emit?.('component-error', { nodePath, cleared: true });
        },
      };
    }

    const component = createSdkComponent(this.opts.host, env, meta.code, {
      callDeadlineMs: this.opts.callDeadlineMs,
    });
    adapter.attach(component);
    inst.adapter = adapter;
    inst.component = component;
    // Auto-teardown register (LIFO): component first (bridge unsubscribes +
    // cancels pending timers while the heap is still alive), then adapter.
    inst.addTeardown(() => adapter.dispose());
    inst.addTeardown(() => component.dispose());

    if (!component.ok) {
      const reason = `setup failed: ${component.error?.message ?? 'unknown error'}`;
      inst.disable(reason);
      this.opts.onInstanceDisabled?.(nodePath, reason);
    } else {
      this.registerRoutingHandlers(inst, env, nodePath);
    }
    return inst;
  }

  /**
   * Path routing hooks (plan-268 Phase 6): a script whose setup return
   * declares `routing.*` handlers becomes the path network's project router.
   * Dispatch is a SYNCHRONOUS host→VM `callHandler` — the same pattern as the
   * DES station handshake (`stationCanAccept`): plain-value arguments in
   * (string ids + a POJO context), a plain string id back. A failed or
   * non-string `selectNextPath` result yields `undefined` → the network falls
   * back to the default route (`candidateIds[0]`) — a broken script can slow
   * routing down but never derail the mechanics. The registration is
   * unregistered by the instance teardown (dispose / hot-reload).
   */
  private registerRoutingHandlers(
    inst: WebComponentInstance,
    env: SdkEnvironment,
    nodePath: string,
  ): void {
    const component = inst.component;
    const backend = env.routing;
    if (!component || !backend) return;
    const hasSelect = component.hasHandler('routing.selectNextPath');
    const hasArrive = component.hasHandler('routing.onArrive');
    const hasDispatch = component.hasHandler('routing.requestDispatch');
    if (!hasSelect && !hasArrive && !hasDispatch) return;

    const callRouting = (path: string, ...args: unknown[]): unknown => {
      const r = component.callHandler(path, ...args);
      if (!r.ok) {
        if (r.error && r.error.name !== 'ContextDisabledError') {
          console.warn(`[web-component:${nodePath}] handler '${path}' failed: ${r.error.message}`);
        }
        return undefined;
      }
      return r.value;
    };
    const unregister = backend.register({
      selectNextPath: hasSelect
        ? (candidateIds, ctx): string | undefined => {
            const v = callRouting('routing.selectNextPath', candidateIds, ctx);
            return typeof v === 'string' ? v : undefined;
          }
        : undefined,
      onArrive: hasArrive
        ? (pathId, travelerId): void => { callRouting('routing.onArrive', pathId, travelerId); }
        : undefined,
      requestDispatch: hasDispatch
        ? (travelerId): void => { callRouting('routing.requestDispatch', travelerId); }
        : undefined,
    });
    inst.addTeardown(unregister);
  }

  /** Surfaces a poison-backoff disable (deadline/memory abort) exactly once. */
  private surfacePoisonDisable(inst: WebComponentInstance): void {
    if (!inst.isDisposed && !inst.isDisabled) return;
    if (inst.component?.ctx.isDisabled && !inst.isDisposed
      && inst.disabledReason !== null && !this.notifiedDisables.has(inst.nodePath)) {
      this.notifiedDisables.add(inst.nodePath);
      this.opts.onInstanceDisabled?.(inst.nodePath, inst.disabledReason);
    }
  }

  private readonly notifiedDisables = new Set<string>();

  private assertUsable(operation: string): void {
    if (this.disposed) {
      throw new Error(`RVWebComponentRegistry.${operation}: registry has been disposed`);
    }
  }
}

// ─── Scene wiring ───────────────────────────────────────────────────────────

/** Default hierarchy path: ancestor names root→leaf joined by '/'.
 *  Exported so editor entry points (phase 3) resolve nodes with the SAME
 *  path convention the wiring used. */
export function computeWebComponentNodePath(node: Object3D): string {
  const parts: string[] = [];
  let cur: Object3D | null = node;
  while (cur && (cur as { isScene?: boolean }).isScene !== true && cur.parent) {
    if (cur.name) parts.unshift(cur.name);
    cur = cur.parent;
  }
  return parts.join('/');
}

export interface WireWebComponentsOptions {
  /**
   * Trust gate (§10, v1-minimal): script execution is OFF BY DEFAULT for
   * loaded GLBs. Instances are only created when the caller passes `true`
   * (the phase-3 editor UI adds the per-model confirmation flow).
   */
  allowScripts?: boolean;
  /** Node-path resolver override (default: hierarchy walk root→leaf). */
  pathOf?: (node: Object3D) => string;
}

export interface WireWebComponentsResult {
  /** Instances created (allowScripts=true only). */
  created: WebComponentInstance[];
  /** Nodes with a `WebComponent` entry blocked by the trust gate. */
  blocked: number;
  /** Nodes whose `WebComponent` entry failed the defensive parse. */
  malformed: number;
}

/** Counts nodes carrying a `WebComponent` rv_extras entry (trust-gate scan). */
export function countWebComponents(root: Object3D): number {
  let n = 0;
  root.traverse((node) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (rv && rv.WebComponent !== undefined) n++;
  });
  return n;
}

/**
 * Traverses a loaded scene, parses every `userData.realvirtual.WebComponent`
 * (§7, defensive) and creates instances in `registry` — gated by
 * `allowScripts` (default FALSE, §10). Standalone by design: called from
 * `web-component-plugin.ts` on `onModelLoaded` (or from tests/tools) — no
 * scene-loader integration required.
 */
export function wireWebComponents(
  root: Object3D,
  registry: RVWebComponentRegistry,
  opts: WireWebComponentsOptions = {},
): WireWebComponentsResult {
  const allow = opts.allowScripts === true;
  const pathOf = opts.pathOf ?? computeWebComponentNodePath;
  const result: WireWebComponentsResult = { created: [], blocked: 0, malformed: 0 };
  root.traverse((node) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv || rv.WebComponent === undefined) return;
    const meta = parseWebComponent(rv.WebComponent);
    if (!meta) {
      result.malformed++;
      return;
    }
    if (!allow) {
      result.blocked++;
      return;
    }
    result.created.push(registry.create(pathOf(node), node, meta));
  });
  return result;
}
