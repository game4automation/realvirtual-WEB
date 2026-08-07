// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-component-sdk.ts — the Component-SDK façade (plan-210 §6, phase 1).
 *
 * `createSdkComponent()` turns a `WebComponent.Code` string into a running,
 * sandboxed script component:
 *
 *   1. create an `RVScriptContext` on the shared `RVScriptHost` (phase 0),
 *   2. expose the single whitelist dispatcher `__rvHostCall` (→ `SdkBridge`),
 *   3. inject the math library + guest `self` construction sources,
 *   4. evaluate the user code (global-`setup` contract),
 *   5. install the setup wrapper (binds `self`, retains the `__cb` guest
 *      callback dispatcher) and run `setup()`.
 *
 * Failures at ANY step disable the component (`setup-failure isolation`) and
 * come back structured on the returned `SdkComponent` — they never throw, and
 * they never take the rest of the scene down.
 *
 * The kernel side (ticking `continuous.fixedUpdate`, draining timers,
 * DES `Script.Hook` dispatch) is `RVScriptComponentAdapter`
 * (rv-script-component-adapter.ts).
 */

import type { RVScriptHost, RVScriptContext } from '../engine/rv-script-host';
import type { SandboxError, SandboxResult } from '../engine/rv-script-sandbox';
import { SDK_MATH_INSTALL_SOURCE } from './rv-sdk-math';
import {
  SDK_SELF_SOURCE,
  SDK_SETUP_WRAPPER_SOURCE,
  SdkBridge,
  seedFromPath,
  type SdkEnvironment,
} from './rv-sdk-self';

export interface CreateSdkComponentOptions {
  /** Per host→VM call deadline in ms (default: the script-host default, 5 ms). */
  callDeadlineMs?: number;
}

/** A loaded (or failed-and-disabled) script component. */
export interface SdkComponent {
  /** The underlying guest context (poison/disable state, retained handlers). */
  readonly ctx: RVScriptContext;
  /** The host bridge (subscription hygiene, `__rvHostCall` dispatch). */
  readonly bridge: SdkBridge;
  /** False when any load/setup step failed — the component is disabled. */
  readonly ok: boolean;
  /** The structured failure of the first failed step (null when ok). */
  readonly error: SandboxError | null;
  /** True when `setup()` returned a handler at the dotted path. */
  hasHandler(path: string): boolean;
  /** Invoke a retained lifecycle handler host→VM (throw-free). */
  callHandler(path: string, ...args: unknown[]): SandboxResult;
  /** Disable the component (context refuses further guest calls). */
  disable(reason: string): void;
  /** Dispose guest context + host-side subscriptions. Idempotent. */
  dispose(): void;
}

/**
 * Build and set up one script component against `env`. Synchronous — the
 * caller creates the shared `RVScriptHost` once (async WASM load) and then
 * mints components at will.
 */
export function createSdkComponent(
  host: RVScriptHost,
  env: SdkEnvironment,
  code: string,
  opts: CreateSdkComponentOptions = {},
): SdkComponent {
  const bridge = new SdkBridge(env);
  const ctx = host.createContext({
    callDeadlineMs: opts.callDeadlineMs,
    onDisable: (reason) => {
      // Surface via env.log so the disable is visible without a debugger.
      (env.log ?? ((...a: unknown[]) => console.warn(`[sdk:${env.path}]`, ...a)))(
        `component disabled: ${reason}`,
      );
    },
  });
  bridge.setDisableHook((reason) => ctx.disable(reason));
  ctx.exposeFunction('__rvHostCall', bridge.hostCall);
  bridge.setNotifier((subId, args) => {
    const r = ctx.callHandler('__cb', subId, args);
    if (!r.ok && r.error
      && r.error.name !== 'ContextDisabledError' && r.error.name !== 'ContextDisposedError') {
      console.warn(`[sdk:${env.path}] guest callback failed:`, r.error.message);
    }
  });

  let error: SandboxError | null = null;
  const step = (label: string, run: () => SandboxResult): boolean => {
    if (error) return false;
    const r = run();
    if (!r.ok) {
      const cause: SandboxError = r.error ?? { name: 'UnknownError', message: 'unknown failure' };
      error = { ...cause, message: `${label}: ${cause.message}` };
      ctx.disable(`${label} failed: ${cause.message}`);
      return false;
    }
    return true;
  };

  const meta = {
    name: env.name,
    path: env.path,
    seed: env.seed ?? seedFromPath(env.path),
    props: env.props ?? {},
  };

  const steps: Array<[string, () => SandboxResult]> = [
    ['math install', () => ctx.evaluate(SDK_MATH_INSTALL_SOURCE)],
    ['self install', () => ctx.evaluate(SDK_SELF_SOURCE)],
    ['meta install', () => ctx.evaluate(`globalThis.__rvMeta = ${JSON.stringify(meta)}; 'ok';`)],
    ['load script', () => ctx.loadScript(code)],
    ['setup wrapper', () => ctx.evaluate(SDK_SETUP_WRAPPER_SOURCE)],
    ['setup', () => ctx.runSetup()],
  ];
  for (const [label, run] of steps) {
    if (!step(label, run)) break;
  }

  let disposed = false;
  return {
    ctx,
    bridge,
    get ok(): boolean {
      return error === null;
    },
    get error(): SandboxError | null {
      return error;
    },
    hasHandler(path: string): boolean {
      return ctx.hasHandler(path);
    },
    callHandler(path: string, ...args: unknown[]): SandboxResult {
      return ctx.callHandler(path, ...args);
    },
    disable(reason: string): void {
      ctx.disable(reason);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      bridge.dispose();
      ctx.dispose();
    },
  };
}

// ─── Re-exports: one import surface for SDK consumers ──────────────────────

export { RVEventHeap, type ScheduledHookEvent, type HookEventListener } from './rv-event-heap';
export {
  createHeapScheduler,
  RV_EVERY_HOOK,
  RV_MSG_HOOK,
  type SdkScheduler,
  type ScriptHookDispatcher,
  type ScriptHookEventData,
  type ScriptMuRef,
  type ScriptPortDesc,
  type ScriptMessageData,
} from './rv-script-hook';
export {
  createSnapGraphPortsBackend,
  type SnapGraphPortsOptions,
} from './rv-sdk-ports';
export {
  createLocalFlowBackend,
  type LocalFlowBackend,
  type LocalFlowBackendOptions,
  type LocalFlowMu,
} from './rv-sdk-flow';
export {
  createPathNetworkPathsBackend,
  createPathNetworkRoutingBackend,
  type PathNetworkPathsBackendOptions,
} from './rv-sdk-paths';
export {
  SdkBridge,
  seedFromPath,
  type SdkEnvironment,
  type SdkComponentResolver,
  type SdkComponentListResolver,
  type SdkComponentKind,
  type SdkSignalAccess,
  type SdkPortTarget,
  type SdkFlowBackend,
  type SdkStatsBackend,
  type SdkScriptComponentAccess,
  type SdkScriptComponentInfo,
  type SdkErrorSink,
  type SdkPathDesc,
  type SdkPathsBackend,
  type SdkPathRouter,
  type SdkRouteContext,
  type SdkRoutingBackend,
  type SdkDriveTarget,
  type SdkSensorTarget,
  type SdkBeltTarget,
  type SdkTransportTarget,
  type SdkSourceTarget,
  type SdkSinkTarget,
  type SdkGripTarget,
  type SdkLogicStepTarget,
} from './rv-sdk-self';
export {
  buildSdkMathHost,
  SDK_MATH_SOURCE,
  SDK_MATH_INSTALL_SOURCE,
  type SdkMathLib,
  type Vec3,
  type Quat,
  type Mat4,
  type AABB,
} from './rv-sdk-math';
export { generateSdkDts, SDK_MINIMAL_LIB_DTS } from './rv-sdk-dts';
export { RVScriptComponentAdapter, type ScriptComponentAdapterOptions } from './rv-script-component-adapter';
export { lintDesSafety, type DesLintDiagnostic, type DesLintOptions } from './rv-des-lint';
