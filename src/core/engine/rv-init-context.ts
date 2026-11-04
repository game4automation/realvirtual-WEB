// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-init-context.ts — ONE builder of the init context (plan-757 D3 / F4).
 *
 *   load → prepare → bake → drop → place → **init**
 *
 * `initSubtree` (rv-scene-loader.ts) is the one init; what it needs is the
 * four runtime systems plus the viewer-owned subsystems components register
 * with. Before plan-757 that list was hand-maintained THREE times — the
 * `loadGLB` option bag, the fourteen positional parameters of `processExtras`
 * and the planner's call to it — and a subsystem forgotten on one list was a
 * placed component that silently registered nowhere.
 *
 * {@link buildInitContext} is a FREE function on purpose: `RVViewer` wraps it
 * (`viewer.initContext()`), and the embed facade — which has no `RVViewer` —
 * calls it with its own dependencies. Call sites add only per-source data
 * (renamed nodes, aliases, the trust gate, the home-pose mode).
 *
 * Import boundary (`tests/engine-import-boundary.node.test.ts`): nothing from
 * `src/core/rv-viewer.ts`, `src/plugins/` or `src/core/hmi/`.
 */

import type { Scene } from 'three';
import type { NodeRegistry } from './rv-node-registry';
import type { SignalStore } from './rv-signal-store';
import type { RVTransportManager } from './rv-transport-manager';
import type { GizmoOverlayManager } from './rv-gizmo-manager';
import type { LampManager } from './rv-lamp-manager';
import type { WebLabelManager } from './rv-web-label-manager';
import type { RVOutlineManager } from './rv-outline-manager';
import type { EnergyChainManager } from './rv-energy-chain-manager';
import type { SceneButtonManager } from './rv-scene-button-manager';
import type { ChainManager } from './rv-chain-manager';
import type { RibbonManager } from './rv-ribbon-manager';
import type { MachiningManager } from './rv-machining-manager';
import type { CollisionRoleRegistrar } from './rv-collision-role';
import type { DropDetectionRegistrar } from './rv-drop-detection';
import type { ErrorStore } from './rv-error-store';
import type { RVHighlightManager } from './rv-highlight-manager';
import type { InstructionRuntimeStore } from './rv-instruction-runtime-store';
import type { RVExtrasOverlay } from './rv-extras-overlay-store';
import type { EventEmitter } from '../rv-events';
import type { ViewerEvents } from '../rv-viewer-events';
import { getActiveSignalReapplyRegistry, type SignalReapplyRegistry } from './rv-signal-reapply-registry';

/**
 * The viewer-owned subsystems a component may register with. All optional —
 * components null-check; a minimal test viewer or the embed facade passes
 * none. ONE list: `LoadGLBOptions` extends it, `buildInitContext` copies it.
 */
export interface InitSubsystems {
  /** Passed into ComponentContext so components (e.g. WebSensor) can create overlays. */
  gizmoManager?: GizmoOverlayManager;
  /** Viewer-owned manager for Lamp flashing. */
  lampManager?: LampManager;
  /** plan-529 — so a WebLabel reaches the render-path label pass. */
  webLabelManager?: WebLabelManager;
  /** Outline manager — CustomRuntimeInstruction drives the OutlinePass status outline. */
  outlineManager?: RVOutlineManager;
  energyChainManager?: EnergyChainManager;
  /** 3D scene buttons (plan-417). */
  sceneButtonManager?: SceneButtonManager;
  /** plan-733 — so a Chain reaches the per-tick pose registry. */
  chainManager?: ChainManager;
  /** plan-459 — so a RibbonPath reaches the per-tick web registry. */
  ribbonManager?: RibbonManager;
  /** CSG machining registry (plan-405). */
  machiningManager?: MachiningManager;
  /** Collision-role registry (plan-394). */
  collisionManager?: CollisionRoleRegistrar;
  /**
   * Optional viewer-owned drop-detection registry (plan-2022). The one
   * `DropDetection` component of the scene registers its configuration here;
   * every other component ignores it. Absent (or no component) = the detection
   * is off and no existing model changes behaviour.
   */
  dropManager?: DropDetectionRegistrar;
  /** Viewer event bus — components that react to UI↔engine signals. */
  events?: EventEmitter<ViewerEvents>;
  /** Error registry (WebError). */
  errorStore?: ErrorStore;
  /** Runtime-instruction registry (CustomRuntimeInstruction). */
  instructionStore?: InstructionRuntimeStore;
  /** The highlight pipeline (hover / selection / aux / flash channels) — a
   *  component that marks its node (WebError's red X-ray overlay + alarm flash)
   *  goes through it instead of building per-mesh gizmo copies. */
  highlighter?: RVHighlightManager;
  /** Signal re-apply registry (plan-427). Falls back to the module slot. */
  reapply?: SignalReapplyRegistry;
}

/** The key list of {@link InitSubsystems} — what `subsystemsOf` picks out of a wider bag. */
export const INIT_SUBSYSTEM_KEYS: ReadonlyArray<keyof InitSubsystems> = Object.freeze([
  'gizmoManager', 'lampManager', 'webLabelManager', 'outlineManager', 'energyChainManager', 'sceneButtonManager',
  'chainManager', 'ribbonManager', 'machiningManager', 'collisionManager', 'dropManager', 'events',
  'errorStore', 'instructionStore', 'highlighter', 'reapply',
] as const);

/** The four runtime systems every init needs, plus the subsystems. */
export interface InitContextDeps extends InitSubsystems {
  registry: NodeRegistry;
  signalStore: SignalStore;
  transportManager: RVTransportManager;
  scene: Scene;
  /** rv-extras overlay, applied per node BEFORE any component reads userData. */
  overlay?: RVExtrasOverlay;
}

/**
 * What every call site of the init shares. Per-source data (renamed nodes,
 * aliases, the trust gate, the home-pose mode, the authoring flag) is added by
 * the caller on top of this — see `SubtreeInitContext` (rv-scene-loader.ts),
 * which extends it.
 */
export interface InitContextBase extends InitContextDeps {}

/** The {@link InitSubsystems} half of a wider option bag (e.g. `LoadGLBOptions`), nothing else. */
export function subsystemsOf(source: InitSubsystems | undefined): InitSubsystems {
  const out: InitSubsystems = {};
  if (!source) return out;
  for (const key of INIT_SUBSYSTEM_KEYS) {
    const value = source[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * Build the init context from a dependency bag. The ONE place the subsystem
 * list is spelled out for the init; a new subsystem is one field in
 * {@link InitSubsystems} and one line here, not a signature change in three
 * places. Normalises the plan-427 re-apply registry to the module slot when
 * the caller has none (the placement entries own no registry of their own).
 */
export function buildInitContext(deps: InitContextDeps): InitContextBase {
  return {
    registry: deps.registry,
    signalStore: deps.signalStore,
    transportManager: deps.transportManager,
    scene: deps.scene,
    overlay: deps.overlay,
    gizmoManager: deps.gizmoManager,
    lampManager: deps.lampManager,
    webLabelManager: deps.webLabelManager,
    outlineManager: deps.outlineManager,
    energyChainManager: deps.energyChainManager,
    sceneButtonManager: deps.sceneButtonManager,
    chainManager: deps.chainManager,
    ribbonManager: deps.ribbonManager,
    machiningManager: deps.machiningManager,
    collisionManager: deps.collisionManager,
    dropManager: deps.dropManager,
    events: deps.events,
    errorStore: deps.errorStore,
    instructionStore: deps.instructionStore,
    highlighter: deps.highlighter,
    reapply: deps.reapply ?? getActiveSignalReapplyRegistry() ?? undefined,
  };
}
