// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-hook-adapter.ts -- Register a MaterialFlowDefinition's `des` hooks as
 * DES named actions (Plan 194 §2.2 / §2.6 / R3).
 *
 * For a definition `def` of type `<Type>`, every present `def.des` hook becomes
 * a named action `"MF.<Type>.<Suffix>"` (e.g. onArrival → "MF.Conveyor.Arrival",
 * canAccept → "MF.Conveyor.CanAccept"). The hook-name → integer-index resolution
 * happens ONCE here at registration time (R3 / GC-free dispatch): the returned
 * `HookDispatch` carries a `Map<Suffix, actionIndex>` so `self.in('Arrival', …)`
 * resolves the integer with no per-tick string work.
 *
 * The dispatch wrapper resolves the owning `MaterialFlowAdapter` from the
 * DESManager via the event's integer `_entityId` and calls the corresponding `def.des` hook
 * with the adapter's `self`. A side-channel `data.mu` carries the MU (the queue
 * stores only the integer muId; the runner threads the MU object through the
 * event data payload so the hooks receive the structural `MU`).
 *
 * This module imports ONLY private DES engine internals (`rv-des-named-actions`,
 * `rv-des-manager`) plus the PUBLIC material-flow types — it lives in the
 * private folder because it speaks the private named-action table.
 */

import type {
  MaterialFlowDefinition,
} from '../../core/material-flow/define-material-flow';
import type { MU, Port } from '../../core/material-flow/material-flow-self';
import { registerAction, ACTION_INDEX } from './rv-des-named-actions';
import type { ActionContext } from './rv-des-event';
import type { IDESComponent, DESManager } from './rv-des-manager';
import { DES } from './rv-des-api';

/**
 * Shape the runner's per-instance adapter must satisfy for hook dispatch. The
 * concrete `MaterialFlowAdapter` (material-flow-adapter.ts) provides it: a
 * `def` + `self` + the `dispatchHook(name, mu, port, data)` entry point.
 */
export interface HookDispatchTarget extends IDESComponent {
  readonly def: MaterialFlowDefinition;
  /** Invoke a `des` hook by its short suffix with the resolved MU/port/data. */
  dispatchHook(suffix: string, mu: MU | null, port: Port | undefined, data: unknown): void;
}

/**
 * Build the named-action name for a MaterialFlow `des` hook.
 *
 * The `MF.` namespace is part of persisted snapshot action names and MUST stay
 * stable. Both registration (here) and the runner scheduler use this builder.
 */
export function mfActionName(type: string, suffix: string): string {
  return `MF.${type}.${suffix}`;
}

/** All `des` hook keys and their action-name suffixes (Plan 194 §2.2). */
const HOOK_SUFFIX: Record<string, string> = {
  __attachmentComplete: 'AttachmentComplete',
  canAccept: 'CanAccept',
  onAccept: 'Accept',
  onArrival: 'Arrival',
  onServiceEnd: 'ServiceEnd', // plan-921 — Agv task service time at the destination
  onReplan: 'Replan', // plan-558 — Agv movement-authority events (flush / extend / zone release / stop / notify / field / stat / watchdog)
  onProcessComplete: 'ProcessComplete',
  onRotateComplete: 'RotateComplete',
  onGenerate: 'Generate',
  onAutoRelease: 'AutoRelease',
  onDownstreamReady: 'DownstreamReady',
  onSignalChanged: 'SignalChanged',
  onFreeze: 'Freeze',
  onResume: 'Resume',
};

/** Event-data payload the runner threads through the queue for hook dispatch. */
export interface HookEventData {
  /** The MU object (the queue stores only its integer id). */
  mu?: MU | null;
  /** Optional port (routers). */
  port?: Port;
  /** Arbitrary user payload (`self.in(delay, hook, mu, data)`). */
  data?: unknown;
}

/**
 * The result of registering a definition's hooks: the short-suffix → integer
 * action-index map the DES scheduler uses for GC-free `self.in/at`.
 */
export interface HookDispatch {
  readonly type: string;
  /** suffix (e.g. 'Arrival') → DES action index. Resolved ONCE here (R3). */
  readonly indexBySuffix: ReadonlyMap<string, number>;
}

/** Per-type cache so a re-registration (HMR) does not re-register actions. */
const _dispatchByType = new Map<string, HookDispatch>();

/**
 * Register all `def.des` hooks of a definition as named actions and return the
 * suffix → index dispatch map. Idempotent per `type` (R3). The dispatch wrapper
 * resolves the ACTIVE manager via `DES.getManager()` at call time, so no manager
 * needs to be captured here.
 *
 * @param def the material-flow definition (must have a `des` block to register).
 */
export function registerDesHooks(
  def: MaterialFlowDefinition,
): HookDispatch {
  const cached = _dispatchByType.get(def.type);
  if (cached) return cached;

  const indexBySuffix = new Map<string, number>();
  const des = def.des;

  if (des) {
    for (const hookKey of Object.keys(HOOK_SUFFIX)) {
      const fn = (des as Record<string, unknown>)[hookKey];
      const internalAttachmentHook = hookKey === '__attachmentComplete';
      if (!internalAttachmentHook && typeof fn !== 'function') continue;

      const suffix = HOOK_SUFFIX[hookKey];
      const actionName = mfActionName(def.type, suffix);

      // Resolve / register the named action ONCE (R3, GC-free dispatch). The
      // named-action table is module-global and the action is registered only
      // once per name; the wrapper therefore resolves the manager at dispatch
      // time from the event context (`ctx.manager`, the manager processing the
      // event) — NOT captured from this registration — so a runner built later
      // (e.g. after Reset-on-Switch or in another simulation) dispatches against
      // ITS OWN manager, not a stale one.
      let idx = ACTION_INDEX.get(actionName);
      if (idx === undefined) {
        const expectedType = def.type;
        idx = registerAction(actionName, (ctx: ActionContext) => {
          // The manager that DISPATCHES this event, not the global one: a
          // second runner's DESManager can hold the global slot,
          // and resolving entity / MU ids there hands the hook a foreign
          // component or a null MU (2026-10-26). The global is the fallback for
          // callers that invoke an action without a manager on the context.
          const mgr = (ctx.manager as DESManager | undefined) ?? DES.getManager();
          if (!mgr) return;
          const eid = (ctx as unknown as { _entityId: number })._entityId;
          const comp = mgr.getComponentByEntityId(eid) as HookDispatchTarget | null;
          if (!comp || comp.def?.type !== expectedType) return;
          const payload = (ctx.data ?? null) as HookEventData | null;
          // A registered MU rides the queue as its integer id (GC-free schedule
          // path — no payload allocated); the payload carries it only for
          // unregistered MUs or when user data travels alongside.
          const mu = payload?.mu
            ?? (ctx.muId >= 0 ? (mgr.getMU(ctx.muId) as unknown as MU | null) : null);
          // An event scheduled FOR an MU whose slot no longer resolves is stale —
          // never hand the hook a null where it was promised an MU.
          if (ctx.muId >= 0 && !mu) return;
          comp.dispatchHook(suffix, mu, payload?.port, payload?.data);
        }, { owner: 'component', targetType: def.type, payload: validateHookPayload });
      }
      indexBySuffix.set(suffix, idx);
    }
  }

  const dispatch: HookDispatch = { type: def.type, indexBySuffix };
  _dispatchByType.set(def.type, dispatch);
  return dispatch;
}

/** Test-only: clear the per-type dispatch cache. */
export function _resetDesHookCache(): void {
  _dispatchByType.clear();
}

export function validateHookPayload(data: import('./rv-snapshot-contract').SnapshotJson): readonly string[] {
  if (data === null) return [];
  if (typeof data !== 'object' || Array.isArray(data)) return ['hook payload must be an object'];
  if ('mu' in data) return ['live MU must be encoded as muId'];
  return [];
}
