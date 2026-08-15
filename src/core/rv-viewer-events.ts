// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ViewerEvents — typed event surface emitted by RVViewer.
 *
 * Extracted to its own module so consumers (hooks, engine subsystems) can
 * import the type WITHOUT pulling in the full rv-viewer.ts module.
 * This was the foundational step of plan-182 (architecture refactoring).
 *
 * Keep this file free of any `rv-viewer.ts` import — it lives at the bottom
 * of the dependency graph so engine/ and hooks/ can depend on it cleanly.
 */

import type { LoadResult } from './engine/rv-scene-loader';
import type { RvScene } from './hmi/scene/rv-scene-types';
import type { RVDrive } from './engine/rv-drive';
import type { NodeSearchResult } from './engine/rv-node-registry';
import type { HoverableType, ObjectHoverData, ObjectUnhoverData, ObjectClickData } from './engine/rv-raycast-manager';
import type { SelectionSnapshot } from './engine/rv-selection-manager';
import type { MultiuserSnapshot } from '../plugins/multiuser-plugin';
import type { McpBridgeSnapshot, McpServerLogLine } from '../plugins/mcp-bridge-plugin';
import type { ModeId } from './rv-mode-manager';
import type { RenderMode } from './rv-render-modes';
import type { Object3D } from 'three';
import type { SignatureState } from './persistence/rv-sig-verify';
import type { ModelProvenance } from './rv-model-provenance';

export interface ViewerEvents {
  // ── Existing events (unchanged) ──
  'model-loaded': { result: LoadResult };
  /** Geometry/HMI lifecycle remains on model-loaded; executable model logic
   *  binds only when this event fires (immediately for none/valid, or after an
   *  explicit late activation for invalid/unverifiable signatures). */
  'model-logic-activated': { result: LoadResult };
  'signature-state-changed': {
    signatureState: SignatureState;
    logicRunState: 'active' | 'gated' | 'activating';
  };
  /** Fired when the provenance of the model ON SCREEN changes (plan-423 F6):
   *  at the end of every load, and on `clearModel()`. Distinct from the
   *  load-time `LoadTrustContext`, which is restored the moment a load returns
   *  and is therefore never a valid source for anything the user sees. */
  'model-provenance-changed': { provenance: ModelProvenance };
  'model-cleared': void;
  /** Fired when the asynchronous BVH build for the current model has completed
   *  (plan-240): all merged raycast geometries and per-mesh geometries now
   *  carry their `boundsTree` and hover/click raycasts run BVH-accelerated.
   *  `model-loaded` intentionally does NOT wait for this — between the two
   *  events, raycasting works through the native three.js fallback (slower).
   *  Not fired when the build was aborted by a newer load/clear. */
  'raycast-ready': void;
  /** Fired by engine components (e.g. WebVisibility) after mutating a model
   *  node's `.visible` at runtime. The viewer reacts by re-syncing the
   *  BatchedMesh per-instance visibility and rebuilding the shadow map. */
  'node-visibility-changed': void;
  /** Fired by `RVViewer.setAvailableModels()` when the model catalogue changes
   *  after boot — a model published to a running CONNECT gateway (plan-365).
   *  Consumers that keep their OWN copy of the list must re-read it here;
   *  `SceneStore` is one, because it mirrors `availableModels` into its
   *  built-ins and would otherwise show a catalogue frozen at boot. */
  'models-changed': { models: Array<{ url: string; label: string }> };
  /** Fired by RVViewer.loadScene() once the scene record is fully applied
   *  (base GLB + overlay + placements). Camera plugins listen for this to
   *  apply per-scene camera presets. */
  'scene-loaded': { scene: RvScene };
  'drive-chart-toggle': { open: boolean };
  'drive-filter': { filter: string; filteredDrives: RVDrive[] };
  /** The tick-list `RVViewer.drives` gained or lost a member at RUNTIME
   *  (plan-411 Phase 1). Fired by the drive lifecycle primitive
   *  (`RVViewer.addDrive` / `removeDrive`) — NOT on the bulk model load, which
   *  keeps announcing itself through `model-loaded`.
   *
   *  Consumers that keep their own derived view of the drive collection MUST
   *  listen here, or a drive added in the editor ticks in the wrong order,
   *  stays out of the recorder and never shows up in the UI list:
   *    - `drive-order-plugin`   — re-runs the topological Gear/CAM sort
   *    - `drive-recorder-plugin`— re-seeds the ring buffers
   *    - `use-drives`           — refreshes the React list
   *  Deliberately NOT reacting: the raycast/BVH drive-node set and the
   *  drive-axis gizmo sources, which rebuild from the registry on their own
   *  epoch bump (`instancePickIndex.bumpResolutionEpoch()`), and
   *  `filteredDrives`, which the primitive re-derives itself before emitting. */
  'drives-changed': { drives: readonly RVDrive[]; added: RVDrive | null; removed: RVDrive | null };
  /** A runtime component construction was REFUSED (plan-411 Phase 1). The
   *  typed channel for a construction finding: nothing was created, the caller
   *  rolls the extras stamp back, and the reason is reported here instead of
   *  failing silently. */
  'component-construction-failed': { nodePath: string; componentType: string; reason: string };
  'node-filter': { filter: string; filteredNodes: NodeSearchResult[]; tooMany: boolean };
  'sensor-chart-toggle': { open: boolean };
  'groups-overlay-toggle': { open: boolean };
  'exclusive-hover-mode': { mode: HoverableType | null };

  // ── Connection state ──
  'connection-state-changed': { state: 'Connected' | 'Disconnected'; previous: 'Connected' | 'Disconnected' };

  // ── WebGL context lifecycle ──
  /** Fired when the WebGL/WebGPU drawing context is lost (common on mobile
   *  under GPU-memory pressure or after a long background tab). The default
   *  browser behaviour (a permanently blank canvas) is suppressed via
   *  preventDefault so the browser attempts a restore; UI listens to surface a
   *  message and offer a reload. */
  'renderer-context-lost': void;
  /** Fired when a previously lost context is restored by the browser. */
  'renderer-context-restored': void;

  /** Fired whenever the active render mode changes (dropdown, settings apply, or
   *  programmatic `viewer.renderMode = …`). UI that gates controls by mode
   *  capabilities (e.g. the Environment tab hiding Reflection in toon) listens
   *  here to stay in sync without polling. */
  'render-mode-changed': { mode: RenderMode };

  // ── Generic component event ──
  /** Emitted by any RVComponent (drive, sensor, MU, custom plugin component) when
   *  it reports a runtime state change. Replaces the previous per-type events
   *  (sensor-changed, mu-spawned, mu-consumed, drive-at-target). New component
   *  types add their own `componentType` without extending ViewerEvents.
   *
   *  Known kinds:
   *    - sensor   : 'changed'   payload: { occupied: boolean }
   *    - mu       : 'spawned'   payload: { totalSpawned: number }
   *    - mu       : 'consumed'  payload: { totalConsumed: number }
   *    - drive    : 'at-target' payload: { position: number }
   */
  'component-event': {
    componentType: string;
    kind: string;
    path: string;
    payload?: unknown;
  };

  // ── Interface events (emitted by interface plugins) ──
  'interface-connected': { interfaceId: string; type: string };
  'interface-disconnected': { interfaceId: string; reason?: string };
  'interface-error': { interfaceId: string; error: string };
  'interface-data': { interfaceId: string; signals: Record<string, unknown> };
  /**
   * The first incoming signal snapshot after a (re)connect has been COMMITTED
   * to the SignalStore (plan-427 F2).
   *
   * Not the same moment as `'interface-connected'`: that fires before signal
   * discovery, and the values arriving from discovery/subscription sit in the
   * adapter's `pendingIncoming` buffer until the next fixed-step flush. Only
   * after that flush does the store hold the CURRENT remote state — which is
   * when re-applying signal levels onto components is safe. Emitted once per
   * connect (a 2 s timeout covers a silent PLC that sends nothing at all); a
   * failed discovery emits nothing, so no stale level is ever replayed.
   */
  'interface-signals-synced': { interfaceId: string };

  /**
   * A signal was just linked to a slot BY SOMEBODY — a drop, a picker, an MCP
   * bind (plan-425 F8). The chip for that slot pulses once so the act is
   * visibly acknowledged.
   *
   * Emitted at the user/agent-initiated upsert boundary and nowhere else.
   * NOT from `applyMappings()`, which also runs on every model load and on the
   * repair scan — putting it there would flash every restored binding on reload
   * and fire twice for a single MCP bind (review round 1, finding 7).
   */
  'signal-binding-applied': {
    targetId: string;
    componentPath: string;
    slot: string;
    signalName: string;
    sourceKind: 'connect' | 'internal';
  };

  // ── Generic raycast events (emitted by RaycastManager) ──
  'object-hover': ObjectHoverData | null;
  'object-unhover': ObjectUnhoverData;
  'object-click': ObjectClickData;

  // ── UI events (emitted by UI plugins) ──
  'camera-animation-done': { targetPath?: string };
  'object-clicked': { path: string; node: Object3D; hitPoint?: [number, number, number] };
  'selection-changed': SelectionSnapshot;
  /** Frame-on-object trigger. `openInspector === false` (e.g. the F shortcut)
   *  frames the camera only — the hierarchy/inspector listener must NOT open or
   *  reveal. Omitted/true (double-click) opens & reveals as before. */
  'object-focus': { path: string; node: Object3D; openInspector?: boolean };
  /** Fired when a previously focused object is unfocused (focusByPath cleared). */
  'object-blur': void;
  'panel-opened': { panelId: string };
  'panel-closed': { panelId: string };

  // ── AI error diagnosis events (plan-253) ──
  /** Emitted by the `WebDiagnostics` engine marker (rv-web-diagnostics.ts) on a
   *  PLC error-signal edge. The marker NEVER imports a provider (layering/tier);
   *  the diagnose plugin (private tier) subscribes and performs the backend
   *  call. `errorActive: false` = falling edge — the plugin aborts the running
   *  request and removes the card/dialog (F11). */
  'diagnose-request': {
    nodePath: string;
    errorCode?: number;
    errorActive?: boolean;
    docFilter?: string;
    errorId?: string;
    label?: string;
    autoOpen?: boolean;
    /** Documentation paths linked to the node, used as retrieval hints. */
    docHints?: string[];
    /** Size-capped live component metadata and signal state. */
    machineContext?: string;
    /** Stable identifier of the UI surface that initiated the request. */
    source?: string;
  };

  // ── Safety door events (engine listens, UI emits) ──
  /** Show or hide all safety-door gizmos at once.
   *  UI plugins emit this to toggle visibility from a warning tile etc. */
  'safety-door:show-all': { show: boolean };

  // ── XR events ──
  'xr-session-start': void;
  'xr-session-end': void;
  'xr-hit-test': { position: Float32Array; matrix: Float32Array };
  'xr-controller-select': { hand: 'left' | 'right'; position: { x: number; y: number; z: number } };

  // ── FPV events ──
  'fpv-enter': void;
  'fpv-exit': void;

  // ── Camera Follow / Sit-On events ──
  /** Fired when the Follow/Sit-On camera mode changes (toolbar buttons listen
   *  for the active state). `mode` is null when neither mode is active. */
  'camera-mode-changed': { mode: 'follow' | 'siton' | null };

  // ── Multiuser events (emitted by multiuser-plugin) ──
  'multiuser-changed': MultiuserSnapshot;

  // ── MCP Bridge events (emitted by mcp-bridge-plugin) ──
  'mcp-bridge-changed': McpBridgeSnapshot;
  'mcp-bridge-log': McpServerLogLine[];

  // ── Context Menu events ──
  'context-menu-request': { pos: { x: number; y: number }; path: string; node: Object3D };

  // ── Layout events ──
  /** Position/rotation/scale/visibility change on a placed layout object —
   *  emitted by inspector edits, SetPositionDialog, gizmo drags, splat tools,
   *  etc. The planner listens and persists into the layout store + op log.
   *  `scale` and `visible` are optional so old call-sites don't have to be
   *  retrofitted; planner code merges them with the previous snapshot.
   *  Position/rotation arrive as `[x, y, z]` tuples (degrees for rotation)
   *  matching the layout-store wire format and the planner's listener. */
  'layout-transform-update': {
    path: string;
    position: [number, number, number];
    rotation: [number, number, number];
    scale?: [number, number, number];
    visible?: boolean;
  };
  /** Fired by the layout-planner the moment a gizmo drag begins. The snap-
   *  point plugin uses this to arm its magnetic-snap controller. `altKey`
   *  reflects the modifier state at drag-start — listeners may treat this
   *  as a per-drag override (e.g. snap-point plugin treats ALT-held as
   *  "drag solo + detach all connections of the moved asset"). */
  'layout-drag-start': { node: Object3D; altKey?: boolean };
  /** Fired once per drag frame (FloorGizmo onChange) AFTER the gizmo has
   *  applied its own transform but BEFORE the next render. Listeners may
   *  mutate `node.position`/`node.quaternion` to override (used for magnetic
   *  snap-to-snap alignment). */
  'layout-drag-tick': { node: Object3D };
  /** Fired when the gizmo drag ends, before the planner writes the final
   *  transform to its store. */
  'layout-drag-end': { node: Object3D };

  // ── Workspace mode events (plan-198) ──
  /** Fired BEFORE a workspace-mode switch begins (plugins deactivate/activate,
   *  UI swaps). Distinct from the kernel's `simulation-mode-changed`
   *  (Realtime/DES execution) — this is the Blender-style UI workspace mode. */
  'mode-changing': { from: ModeId | null; to: ModeId };
  /** Fired AFTER a workspace-mode switch has fully applied. */
  'mode-changed': { from: ModeId | null; to: ModeId };

  /** Fired after a plugin-registry or enabled-state mutation has completed. */
  'plugins-changed': {
    kind: 'registered' | 'enabled' | 'disabled' | 'removed' | 'user-disabled' | 'user-enabled';
    id: string;
  };

  // ── Script component events (plan-210) ──
  /** Fired after a `WebComponent` script instance was hot-reloaded
   *  (dispose old VM → fresh setup — COLD state). Emitted by the
   *  web-component plugin's instance registry; the phase-3 editor UI and
   *  overlays listen to refresh their state. */
  'component-reloaded': { nodePath: string };

  /** A script component raised (or cleared) an error state via
   *  `self.raiseError(code, message)` / `self.clearError()` (plan-210 phase
   *  1b). `cleared: true` marks the clear notification; other components read
   *  the state via `self.component(path).error` or the conventional
   *  `<Name>.Error` signal. */
  'component-error': { nodePath: string; code?: string; message?: string; cleared?: boolean };

  // ── Editor events ──
  /** Fired after an asset-editor op (forward or inverse — covers undo/redo and
   *  draft replay) changed the scene STRUCTURE: nodes added/removed/renamed or
   *  components added/removed. Listeners rebuild caches (hierarchy panel
   *  editableNodes etc.) and should coalesce — one emit per top-level op. */
  'editor-structure-changed': { source: 'asset-editor' };

  /** Fired when Group memberships changed through editing (Group component
   *  added/removed/renamed, grouped node deleted/restored — both op directions,
   *  undo/redo included). Listeners re-read `viewer.groups`. */
  'groups-changed': { source: 'editor' };

  /** Fired at the START of every asset save/export flow, BEFORE the scene is
   *  cloned for GLB export. Listeners must restore any ephemeral live-preview
   *  state they hold (e.g. the Kinematics window's drive-jog pose) so preview
   *  poses never bake into the saved GLB. Any future export path MUST emit
   *  this too.
   *
   *  `exportAssetGlb()` does NOT emit it — the CALLER does, right before the
   *  export (review finding R2-1). `'test-session'` is the editor's in-place
   *  test run (plan-410 F5), which materialises through the very same export
   *  path and therefore owes the same restore. */
  'asset-editor-pre-export': { source: 'save-flow' | 'test-session' };

  // ── Runtime attachment events ──
  /** Fired when the SimulationRuntime attaches/detaches time integration
   *  (driven by workspace modes with `runtime: 'detached'`, e.g. the asset
   *  editor). While detached, fixedUpdate is never scheduled — stronger than a
   *  pause: no pause reason (or `clearPauseReasons()`) can resume simulation.
   *  Rendering is unaffected. */
  'runtime-attach-changed': { attached: boolean };

  // ── Simulation pause events ──
  /** Fired when the overall simulation pause state transitions (idle ↔ paused).
   *  Plugins can subscribe to stop/resume external PLC I/O, freeze animations,
   *  disable cursor interactions, etc. Not fired when reasons are added/removed
   *  while already paused — only on the idle/paused transition. */
  'simulation-pause-changed': {
    /** New overall pause state. */
    paused: boolean;
    /** All currently active pause reasons (snapshot). */
    reasons: readonly string[];
    /** The specific reason that triggered this transition. */
    reason: string;
  };

  // ── Simulation reset lifecycle events ──
  //
  // Emitted by `RVViewer.resetSimulation()` (the single reset chokepoint — UI
  // reset button + `web_sim_reset` MCP). Together they restore the running
  // model to its freshly-loaded "start" state WITHOUT a reload. Components
  // subscribe through the bind-context hooks `onReset` / `onStart` /
  // `onResetStat` (behavior-runtime.ts) — or directly via `viewer.on(...)`.
  /** Phase 1 — RESET. Every component restores its internal variables and state
   *  to the start (like a reload): behaviors clear their FSM/counters/timers,
   *  drives snap back to their authored StartPosition, conveyor textures rewind.
   *  Fired first among the reset phases — note that when a DES run is in
   *  flight, `'simulation-run-ending'` fires DURING this phase (from the DES
   *  manager's reset hook, which the phase-1 executor reset triggers), so the
   *  finished run is archived with its pre-reset statistics (plan-260 B1). */
  'simulation-reset': void;
  /** Phase 3 — START. Fired LAST, after the reset + engine clear, so components
   *  (re)start from the clean state (e.g. a conveyor re-asserts `Run = true`). */
  'simulation-start': void;
  /** RESETSTAT. Clears statistics accumulators only (throughput, state times,
   *  cycle times) — registrations persist. Primarily a DES concern (reset the
   *  numbers without re-running the model); also fired as part of a full reset. */
  'simulation-resetstat': void;

  // ── Simulation run lifecycle events (plan-260) ──
  //
  // Emitted by the private DES run-lifecycle controller — the archive hook
  // sits in the DES manager's `reset()` (NOT only in `resetSimulation()`), so
  // native DES and the unified DESRunner are both covered (plan-260 B1).
  /** A new simulation RUN started (fresh run id + master seed). Fired when the
   *  DES engine (re)starts with active material-flow components — never for
   *  non-DES scenes. */
  'simulation-run-started': { runId: string; seed: number };
  /** The current simulation RUN is ending and has been handed to the archive:
   *  on reset (`status: 'aborted'`) or when the sim end time was reached
   *  (`status: 'completed'`). `simTime` is the DES clock actually reached
   *  (read from the DES manager — NOT the viewer's continuous clock). */
  'simulation-run-ending': {
    runId: string;
    seed: number;
    simTime: number;
    status: 'completed' | 'aborted';
    reason: 'reset' | 'duration-reached' | 'manual';
  };
}
