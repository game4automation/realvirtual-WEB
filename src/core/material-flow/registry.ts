// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * registry.ts — dual-discovery for material-flow definitions (Plan 194 §2.6).
 *
 * `registerMaterialFlow(def)` wires a definition into THREE discovery paths:
 *
 *  1. Continuous-matcher — keeps the definition in a registry keyed by `type`,
 *     with its `models[]` globs. `matchMaterialFlows(name)` resolves all
 *     definitions whose globs match a loaded model name (via the existing
 *     `compileGlob`/`matchesAny` from behaviors.ts). The ContinuousRunner (P1)
 *     plus the BehaviorManager shim use this.
 *
 *  2. registerComponent adapter — registers the definition's `schema` under its
 *     `type` so the GLB loader auto-maps `rv_extras[type]` → instance props,
 *     using a thin adapter component (material-flow-adapter.ts). This makes a
 *     material-flow type visible to the inspector / hierarchy like any other
 *     component, without requiring the DES runner.
 *
 *  3. Named-action namespace — for every hook present in `def.des`, the action
 *     name `<type>.<Hook>` (e.g. 'Conveyor.Arrival') is reserved. The actual
 *     int-dispatch registration into the DES named-action table happens in the
 *     private `des-hook-adapter` (P5); here we only record the names so the
 *     public side can introspect them deterministically.
 */

import {
  registerComponentSchema,
  getRegisteredFactories,
  type ComponentSchema,
} from '../engine/rv-component-registry';
import { matchesAny } from '../glob-match';
import type { MaterialFlowDefinition } from './define-material-flow';

// ─── Registry state ─────────────────────────────────────────────────────

interface RegisteredFlow {
  readonly type: string;
  readonly models: string[];
  readonly def: MaterialFlowDefinition;
  /** Reserved DES action names `<type>.<Hook>` (for the private runner, P5). */
  readonly desActions: string[];
}

const _flows = new Map<string, RegisteredFlow>();

/** DES hook names recognised in a `des` block (Plan 194 §2.2). */
const DES_HOOK_NAMES = [
  'canAccept', 'onAccept', 'onArrival', 'onProcessComplete', 'onRotateComplete',
  'onGenerate', 'onAutoRelease', 'onDownstreamReady', 'onSignalChanged',
] as const;

/** Hook name → DES action suffix (e.g. onArrival → Arrival, canAccept → CanAccept). */
function hookToActionSuffix(hook: string): string {
  const s = hook.startsWith('on') ? hook.slice(2) : hook;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Register a material-flow definition for dual discovery. Idempotent-overwrite
 * per `type` (a re-`defineMaterialFlow` of the same type — e.g. HMR — replaces).
 */
export function registerMaterialFlow(def: MaterialFlowDefinition): void {
  const type = def.type;
  if (!type) {
    console.warn('[material-flow] registerMaterialFlow: definition has no type — skipped');
    return;
  }
  const models = def.models ?? [`*${type}*`];

  // 1. Continuous-matcher entry + 3. reserved DES action names.
  const desActions: string[] = [];
  if (def.des) {
    for (const hook of DES_HOOK_NAMES) {
      if (typeof def.des[hook] === 'function') {
        desActions.push(`${type}.${hookToActionSuffix(hook)}`);
      }
    }
  }
  _flows.set(type, { type, models, def, desActions });

  // 2. registerComponent schema adapter — make the type loader/inspector visible.
  //    We register only the SCHEMA (not a full create() factory) here, which is
  //    enough for GLB extras auto-mapping + inspector visibility and stays
  //    DES-runner-independent. The full adapter component (extends/implements
  //    the DES handshake) is material-flow-adapter.ts, attached by the runners.
  //
  //    GUARD: when an engine component FACTORY already owns this type (e.g.
  //    'Source' → RVSource, 'Sink' → RVSink), it has already registered the
  //    richer schema (incl. its own CONSUMED fields) and capabilities (badge
  //    colour, hoverable). Overwriting them here would clobber the
  //    engine's inspector schema/badge with the generic MaterialFlow ones — a
  //    regression. The continuous-matcher entry + reserved DES action names
  //    above are all the material-flow registry needs for such types; the engine
  //    factory remains the source of truth for loader/inspector. So we skip the
  //    schema-adapter step when a factory already owns the type.
  if (getRegisteredFactories().has(type)) return;
  try {
    registerComponentSchema(type, def.schema as ComponentSchema, {
      filterLabel: 'MaterialFlow',
      hierarchyVisible: true,
      inspectorVisible: true,
    });
  } catch (e) {
    console.warn(`[material-flow] registerComponentSchema('${type}') failed:`, e);
  }
}

/** All definitions whose `models[]` globs match `name` (continuous-matcher). */
export function matchMaterialFlows(name: string): MaterialFlowDefinition[] {
  const out: MaterialFlowDefinition[] = [];
  for (const f of _flows.values()) {
    if (matchesAny(f.models, name)) out.push(f.def);
  }
  return out;
}

/** Lookup a single registered definition by `type`. */
export function getMaterialFlow(type: string): MaterialFlowDefinition | undefined {
  return _flows.get(type)?.def;
}

/** All registered definitions (diagnostics / runner enumeration). */
export function allMaterialFlows(): MaterialFlowDefinition[] {
  return [..._flows.values()].map(f => f.def);
}

/** Reserved DES action names `<type>.<Hook>` for a type (private runner, P5). */
export function getDesActionNames(type: string): string[] {
  return _flows.get(type)?.desActions.slice() ?? [];
}

/** Test-only: clear the registry. */
export function _resetMaterialFlowRegistry(): void {
  _flows.clear();
}
