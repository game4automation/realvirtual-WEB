// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared signal + drive construction helpers used by both `traverseAndRegister()`
 * and `processExtras()` in rv-scene-loader.ts.
 *
 * The two traversal functions are intentionally kept separate — `traverseAndRegister()`
 * is the rich main-load path (with overlays, renamed-node aliases, validation,
 * MU template + group + kinematic + pipeline + metadata collection), while
 * `processExtras()` is a deliberately leaner re-registration path for dynamically
 * added GLBs (layout planner). Only the *inner* signal and drive construction
 * primitives are shared here — the traversal control flow remains divergent.
 */

import { Object3D } from 'three';
import type { Scene } from 'three';
import { RVDrive } from './rv-drive';
import { RVErraticDriver } from './rv-erratic';
import { RVDriveSimple } from './rv-drive-simple';
import { RVDriveCylinder } from './rv-drive-cylinder';
import { RVDriveDestinationMotor } from './rv-drive-destination-motor';
import { RVDriveGear } from './rv-drive-gear';
import { RVDriveFollowPosition } from './rv-drive-follow-position';
import { RVDriveSpeed } from './rv-drive-speed';
import { RVDrivePositionSwitch } from './rv-drive-position-switch';
import { applySchema, getSchemaDefaults, resolveComponentRefs, type RVComponent, type ComponentSchema, type ComponentContext, type PlcSignalType } from './rv-component-registry';
import type { SignalStore } from './rv-signal-store';
import type { RVTransportManager } from './rv-transport-manager';
import { NodeRegistry } from './rv-node-registry';
import { instanceScopeNode, scopeSignalName } from './rv-instance-scope';

/** Pending component awaiting resolveComponentRefs + init() in the caller's Step 2 phase. */
export interface PendingComponentEntry {
  component: RVComponent;
  type: string;
  path: string;
}

/** Result of `constructDrive` — the constructed drive plus any pending behavior components. */
export interface ConstructDriveResult {
  drive: RVDrive;
  pendingBehaviors: PendingComponentEntry[];
  behaviors: string[];
}

/** Map of known drive behavior types → class + schema for data-driven instantiation.
 *  Kept in sync with the inline map previously in rv-scene-loader.ts so both
 *  traversal paths recognize the same behaviors. */
export const DRIVE_BEHAVIOR_MAP: Record<string, { ctor: new (n: Object3D) => RVComponent; schema: ComponentSchema }> = {
  Drive_ErraticPosition: { ctor: RVErraticDriver, schema: RVErraticDriver.schema },
  Drive_Simple: { ctor: RVDriveSimple, schema: RVDriveSimple.schema },
  Drive_Cylinder: { ctor: RVDriveCylinder, schema: RVDriveCylinder.schema },
  Drive_DestinationMotor: { ctor: RVDriveDestinationMotor, schema: RVDriveDestinationMotor.schema },
  Drive_Gear: { ctor: RVDriveGear, schema: RVDriveGear.schema },
  Drive_FollowPosition: { ctor: RVDriveFollowPosition, schema: RVDriveFollowPosition.schema },
  Drive_Speed: { ctor: RVDriveSpeed, schema: RVDriveSpeed.schema },
  Drive_PositionSwitch: { ctor: RVDrivePositionSwitch, schema: RVDrivePositionSwitch.schema },
};

/** Signal type names recognized from GLB extras. */
export const SIGNAL_TYPES = ['PLCOutputBool', 'PLCInputBool', 'PLCOutputFloat', 'PLCInputFloat', 'PLCOutputInt', 'PLCInputInt'];

/**
 * Register a PLC signal in the SignalStore and the NodeRegistry, identical
 * to the inline logic that previously lived in `traverseAndRegister()` and
 * `processExtras()`.
 *
 * Side-effects (must exactly mirror the original inline code):
 *  - `signalStore.register(signalName, path, initialValue, sigType)`
 *  - `registry.register(sigType, path, { address: path, signalName })`
 *
 * @param node      The node carrying the signal extras (used only for the default name fallback).
 * @param sigType   The signal type key (one of `SIGNAL_TYPES`).
 * @param sigData   The raw extras record for the signal (already validated by the caller if needed).
 * @param path      Pre-computed node path (caller controls path computation).
 * @param signalStore  Target SignalStore.
 * @param registry  Target NodeRegistry.
 * @param signalNameOverride Optional explicit name; when provided, used as the
 *   second-priority lookup *before* falling back to `node.name`. Used by
 *   `traverseAndRegister()` to inject the original renamed-node name; the
 *   leaner `processExtras()` path passes `undefined`.
 * @returns `true` if a signal was registered, `false` if `sigType` was not
 *          recognized as Bool/Float/Int (defensive: no-op on unknown types).
 */
export function registerSignal(
  node: Object3D,
  sigType: string,
  sigData: Record<string, unknown>,
  path: string,
  signalStore: SignalStore,
  registry: NodeRegistry,
  signalNameOverride?: string,
): boolean {
  const status = sigData['Status'] as { Value?: boolean | number } | undefined;
  const signalName = (sigData['Name'] as string) || signalNameOverride || node.name;

  if (sigType.includes('Bool')) {
    signalStore.register(signalName, path, (status?.Value as boolean) ?? false, sigType);
  } else if (sigType.includes('Float')) {
    signalStore.register(signalName, path, (status?.Value as number) ?? 0, sigType);
  } else if (sigType.includes('Int')) {
    signalStore.register(signalName, path, (status?.Value as number) ?? 0, sigType);
  } else {
    // Defensive: unknown signal type — do nothing, do not register a phantom
    // entry in the registry either. The original inline code only registered
    // the registry entry inside the if/else-if chain implicitly via the
    // surrounding `if (rv[sigType])` guard, but registry.register() was called
    // unconditionally after the type dispatch. We preserve that behavior for
    // *known* types and skip both calls for unknown types.
    return false;
  }

  registry.register(sigType, path, { address: path, signalName });

  // Best-effort descriptive metadata from rv_extras (purely for the HMI tooltip).
  // Only the comment is meaningful for scene signals — they have no protocol
  // address (the hierarchy path is their identity). Skip when absent.
  const comment = sigData['Comment'];
  if (typeof comment === 'string' && comment.length > 0) {
    signalStore.setSignalMeta(signalName, { comment });
  }

  return true;
}

/** Render-free signal container name under a drive node (parity with GLB `Signals`). */
const SIGNALS_CONTAINER_NAME = 'Signals';

/** A standard signal a drive behavior auto-provisions when the GLB carries no
 *  explicit componentRef for the slot (F2). Derived from the component's own
 *  schema (`signal:` markers) — the declaration lives IN the component code,
 *  Unity-style, not in a separate table. `seed` is the registered default. */
interface DriveSignalSpec {
  /** Slot name on the behavior instance (= signal Name leaf). */
  slot: string;
  /** PLC signal type (Out = read by viewer, In = written by viewer). */
  type: PlcSignalType;
  seed: boolean | number;
}

/**
 * Derive the standard signal set from a component schema: every componentRef
 * slot carrying a `signal:` marker becomes one spec, in declaration order —
 * exactly mirroring the C# class's `public PLCOutputBool Forward;` field list.
 * Bool slots seed `false`, numeric slots seed `0`.
 */
export function signalSpecsFromSchema(schema: ComponentSchema): DriveSignalSpec[] {
  const specs: DriveSignalSpec[] = [];
  for (const [slot, desc] of Object.entries(schema)) {
    if (desc.type !== 'componentRef' || !desc.signal) continue;
    specs.push({ slot, type: desc.signal, seed: desc.signal.includes('Bool') ? false : 0 });
  }
  return specs;
}

/** Standard signal set of `Drive_DestinationMotor` (derived from its schema). */
export const DESTINATION_MOTOR_SIGNALS: readonly DriveSignalSpec[] =
  signalSpecsFromSchema(RVDriveDestinationMotor.schema);

/** Standard signal set of `Drive_Simple` (derived from its schema). */
export const DRIVE_SIMPLE_SIGNALS: readonly DriveSignalSpec[] =
  signalSpecsFromSchema(RVDriveSimple.schema);

/** Find-or-create the render-free `Signals` container under a drive node.
 *  Reuses an existing `Signals` child (GLB-native OR previously provisioned) so
 *  auto-provisioned drive signals merge into ONE node — no duplicate group. */
function getOrCreateSignalsContainer(driveNode: Object3D): Object3D {
  const existing = driveNode.children.find((c) => c.name === SIGNALS_CONTAINER_NAME);
  if (existing) {
    (existing.userData as Record<string, unknown>)._rvSignals = true;
    return existing;
  }
  const container = new Object3D();
  container.name = SIGNALS_CONTAINER_NAME;
  (container.userData as Record<string, unknown>)._rvSignals = true;
  driveNode.add(container);
  return container;
}

/**
 * Auto-provision the standard signal set for a drive behavior whose slot has no
 * GLB componentRef. Creates a render-free `Object3D` under `<driveNode>/Signals/`,
 * registers it in the SignalStore + NodeRegistry (mirroring {@link registerSignal}'s
 * side-effects), and sets the resolved store PATH on the behavior instance so its
 * `init()` subscription resolves.
 *
 * Idempotent (R1): a slot is provisioned ONLY when the instance field is still
 * empty (no GLB ref). A re-run reuses the existing `Signals` node and does not
 * append a duplicate. A `signalStore.buildIndex()` MUST run afterwards so the
 * later `init()` subscriptions resolve the freshly-registered paths.
 *
 * @param driveNode   The drive node (the `Signals` container hangs here, F3).
 * @param drivePath   Pre-computed drive-node path.
 * @param inst        The behavior instance (signal slot fields written here).
 * @param specs       Standard signal specs (slot/type/seed).
 * @param signalStore Target SignalStore.
 * @param registry    Target NodeRegistry.
 * @param extras      Optional `userData.realvirtual[<type>]` record of the
 *   behavior — provisioned slots are stamped there as `ComponentReference`
 *   objects (the exact shape a Unity GLB export writes), so a code-attached or
 *   auto-provisioned behavior is indistinguishable from an imported one in the
 *   inspector and on GLB re-export.
 * @returns the number of signals actually provisioned (0 if all slots were wired).
 */
// ─── AddSignal — the public signal-creation primitive ─────────────────────────

/** Handle returned by {@link addSignal}: the created signal's PLC symbol NAME,
 *  its hierarchy PATH (subscribe/write address) and the leaf node. */
export interface SignalHandle {
  name: string;
  path: string;
  node: Object3D;
}

export interface AddSignalOpts {
  /** Registered initial value (Bool → false, numeric → 0 when omitted). */
  seed?: boolean | number;
  /** Tooltip comment (defaults to `<plcType> · <name>`). */
  comment?: string;
  /** Mark the leaf force-enabled in the hierarchy (default true). */
  forceable?: boolean;
  /** Pre-computed path of `ownerNode` (use when the subtree is not yet attached
   *  to the scene — e.g. during the initial GLB load). Defaults to
   *  `NodeRegistry.computeNodePath(ownerNode)`. */
  ownerPath?: string;
  /** Host node for the `Signals` folder — "any hierarchy level wished".
   *  Default: the component root (nearest LayoutObject ancestor) so ALL of a
   *  component's signals share ONE folder; outside a LayoutObject the owner
   *  node itself. Must be `ownerNode` or one of its ancestors. */
  at?: Object3D;
}

/**
 * AddSignal — create ONE signal for a component, Unity-style.
 *
 * Creates (or reuses) a render-free leaf under the host's `Signals` folder,
 * stamps the rv_extras signal shape on it (hierarchy badge parity), registers
 * it in the SignalStore + NodeRegistry and returns a {@link SignalHandle} whose
 * `path` can be wired straight onto a component property.
 *
 * `name` is the full readable signal name the caller wants
 * (`'Rot.Destination'`, `'Transport.Forward'`) — it is the leaf name; the PLC
 * symbol is that name instance-scoped (`<LayoutObjectRoot>.<name>`) so two
 * placed copies never collide. The folder LOCATION is chosen automatically (the
 * component root, or `opts.at`); the caller only decides the NAME.
 *
 * Idempotent: re-adding the same name reuses the existing leaf + store entry.
 */
export function addSignal(
  ownerNode: Object3D,
  name: string,
  plcType: PlcSignalType,
  signalStore: SignalStore,
  registry: NodeRegistry,
  opts: AddSignalOpts = {},
): SignalHandle {
  const seed = opts.seed ?? (plcType.includes('Bool') ? false : 0);
  const ownerPath = opts.ownerPath ?? NodeRegistry.computeNodePath(ownerNode);

  // Host of the `Signals` folder: explicit `at`, else the component root
  // (nearest LayoutObject ancestor), else the owner node itself.
  const scopeRoot = instanceScopeNode(ownerNode);
  const scope = scopeRoot?.name ?? '';
  const host = opts.at ?? (scopeRoot && scopeRoot !== ownerNode ? scopeRoot : ownerNode);

  // Host path = owner path minus the segments between owner and host (works
  // for not-yet-attached subtrees where computeNodePath(host) would be short).
  let hostPath = ownerPath;
  if (host !== ownerNode) {
    let depth = 0;
    for (let cur: Object3D | null = ownerNode; cur && cur !== host; cur = cur.parent) depth++;
    hostPath = ownerPath.split('/').slice(0, -depth).join('/');
  }

  const container = getOrCreateSignalsContainer(host);
  const leafName = name;
  const sigName = scopeSignalName(scope, name);
  const sigPath = `${hostPath}/${SIGNALS_CONTAINER_NAME}/${leafName}`;

  // Reuse an existing leaf if a previous run already created it (idempotent).
  let leaf = container.children.find((c) => c.name === leafName) ?? null;
  if (!leaf) {
    leaf = new Object3D();
    leaf.name = leafName;
    container.add(leaf);
  }
  // userData.realvirtual[sigType] shape that the hierarchy scan + badge read.
  const ud = leaf.userData as { realvirtual?: Record<string, unknown>; rvForceable?: boolean };
  (ud.realvirtual ??= {})[plcType] = { Name: sigName, Status: { Value: seed } };
  ud.rvForceable = opts.forceable ?? true;

  // Register the node, then reuse registerSignal for the store + registry +
  // tooltip-metadata side-effects (parity with GLB-authored signals).
  registry.registerNode(sigPath, leaf);
  registerSignal(
    leaf,
    plcType,
    { Name: sigName, Status: { Value: seed }, Comment: opts.comment ?? `${plcType} · ${name}` },
    sigPath,
    signalStore,
    registry,
  );

  return { name: sigName, path: sigPath, node: leaf };
}

/** Build the ComponentReference record a Unity GLB export writes for a wired
 *  signal slot — used to stamp rv_extras so code-created equals imported. */
export function componentReference(sig: SignalHandle | string, plcType: PlcSignalType): Record<string, unknown> {
  return { type: 'ComponentReference', path: typeof sig === 'string' ? sig : sig.path, componentType: plcType };
}

/**
 * Construct an `RVDrive` from extras and collect any recognized `Drive_*`
 * behavior components. Mirrors the inline construction that previously lived
 * in both `traverseAndRegister()` and `processExtras()`.
 *
 * Side-effects (must exactly mirror the original inline code):
 *  - Creates RVDrive(node), applySchema(...)
 *  - Sets drive.Behaviors / drive.BehaviorExtras
 *  - Calls drive.initDrive()
 *  - Registers the drive in registry under type "Drive"
 *  - Sets node.userData._rvType = 'Drive'
 *  - Instantiates Drive_* behavior components via DRIVE_BEHAVIOR_MAP +
 *    applySchema and returns them as pending entries
 *
 * Behavior validation (`validateExtras(key, bExtras)`) is intentionally NOT
 * performed here — it is the caller's responsibility, because
 * `traverseAndRegister()` validates while `processExtras()` does not.
 *
 * Auto-provisioning (F2): for a `Drive_DestinationMotor` behavior whose standard
 * signal slots carry no GLB componentRef, the standard signal set is registered
 * automatically under `<drivePath>/Signals/*` and wired onto the instance — the
 * caller MUST run `signalStore.buildIndex()` after construction so the later
 * `init()` subscriptions resolve. Pass `signalStore` to enable this; when omitted
 * (legacy callers) provisioning is skipped.
 *
 * @param node     The drive node.
 * @param rv       The full `userData.realvirtual` record (used to scan for Drive_* keys).
 * @param driveData The 'Drive' sub-record from rv (extras already pulled out by caller).
 * @param path     Pre-computed node path.
 * @param registry Target registry.
 * @param signalStore Target SignalStore (retained for caller compatibility).
 * @param onBehaviorExtras Optional callback fired for each discovered Drive_*
 *   behavior name + its extras record — used by `traverseAndRegister()` to run
 *   `validateExtras()` per behavior. `processExtras()` passes `undefined`.
 * @returns the constructed drive + collected pending behavior entries, OR
 *          `null` if `driveData.Direction` is missing/falsy (matching the
 *          original guard).
 */
export function constructDrive(
  node: Object3D,
  rv: Record<string, unknown>,
  driveData: Record<string, unknown>,
  path: string,
  registry: NodeRegistry,
  signalStore?: SignalStore,
  onBehaviorExtras?: (behaviorKey: string, behaviorExtras: Record<string, unknown>) => void,
): ConstructDriveResult | null {
  const dirStr = driveData['Direction'] as string | undefined;
  if (!dirStr) return null;

  const drive = new RVDrive(node);
  applySchema(drive as unknown as Record<string, unknown>, RVDrive.schema, driveData);

  // Exactly one Drive_* behavior is active. GLB key order is the authored order;
  // the first behavior wins deterministically and later entries remain metadata
  // only so they can be diagnosed without being constructed or registered.
  const authoredBehaviors = Object.keys(rv).filter((key) => key !== 'Drive' && key.startsWith('Drive_'));
  const behaviors = authoredBehaviors.slice(0, 1);
  const behaviorExtras: Record<string, Record<string, unknown>> = {};
  for (const key of authoredBehaviors) {
    const bExtras = rv[key] as Record<string, unknown>;
    if (key === behaviors[0]) behaviorExtras[key] = bExtras;
    if (onBehaviorExtras) onBehaviorExtras(key, bExtras);
  }
  for (let i = 1; i < authoredBehaviors.length; i++) {
    console.warn(
      `[loader] Drive "${path}" has multiple Drive_* behaviors; keeping "${authoredBehaviors[0]}" and skipping "${authoredBehaviors[i]}"`,
    );
  }
  drive.Behaviors = behaviors;
  drive.BehaviorExtras = behaviorExtras;
  drive.initDrive();

  registry.register('Drive', path, drive);
  node.userData._rvType = 'Drive';

  // Instantiate recognized drive behaviors via data-driven map
  const pendingBehaviors: PendingComponentEntry[] = [];
  for (const bName of behaviors) {
    const entry = DRIVE_BEHAVIOR_MAP[bName];
    if (entry) {
      const inst = new entry.ctor(node);
      applySchema(inst as unknown as Record<string, unknown>, entry.schema, behaviorExtras[bName] ?? {});

      registry.register(bName, path, inst);
      pendingBehaviors.push({ component: inst, type: bName, path });
    }
  }

  return { drive, pendingBehaviors, behaviors };
}

// ─── Attach a drive behavior model BY CODE (library setup path) ───────────────

/** Drive behavior types this helper can attach by code. */
export type AttachableDriveBehaviorType =
  | 'Drive_DestinationMotor'
  | 'Drive_Simple'
  | 'Drive_FollowPosition';

/**
 * Minimal viewer surface {@link attachDriveBehaviorByCode} needs. The RVViewer
 * satisfies this structurally (its `signalStore`/`registry` are nullable until a
 * model is loaded — the helper guards on both). A plain object with these fields
 * works in tests, so the helper carries no hard dependency on RVViewer.
 */
export interface DriveBehaviorHostViewer {
  signalStore: SignalStore | null;
  registry: NodeRegistry | null;
  scene: Scene;
  transportManager?: RVTransportManager | null;
  gizmoManager?: ComponentContext['gizmoManager'];
  lampManager?: ComponentContext['lampManager'];
}

/**
 * Attach a supported drive behavior model to
 * an existing drive node entirely BY CODE — the runtime counterpart of the
 * GLB-authored behavior the loader instantiates in {@link constructDrive}, and
 * deliberately INDISTINGUISHABLE from an import: the node gets the rv_extras
 * record, plus a registered and initialized instance. Signal references are
 * added only when the caller supplies explicit wiring.
 *
 * Uses the EXACT same primitives as the loader so the two paths can never drift:
 *  - stamps `driveNode.userData.realvirtual['<type>'] = {}` (parity with GLB
 *    rv_extras, so the binding-slot resolver + hierarchy/export recognise it),
 *  - applies only explicitly supplied signal wiring,
 *  - registers the instance under its type in the registry (so the resolver's
 *    `getByPath('<type>', path)` finds it and the binding manager can set
 *    `liveControlled`),
 *  - runs `resolveComponentRefs` + `init(ctx)` exactly like loader STEP 2,
 *  - rebuilds the signal index so subscriptions/paths resolve.
 *
 * Idempotent: if the node already carries this behavior (registry instance OR
 * `userData.realvirtual[type]` stamp) the existing instance is returned and no
 * second one is attached.
 *
 * @returns the attached (or pre-existing) instance, or `null` when the viewer has
 *          no signalStore/registry yet, the type is unknown, or no `RVDrive` is
 *          registered at the node's path.
 */
/** Explicit slot → signal wiring for {@link attachDriveBehaviorByCode}: maps a
 *  component slot name to a {@link SignalHandle} (from {@link addSignal}) or a
 *  raw signal path. Wired slots are NOT auto-created. */
export type SignalWiring = Record<string, SignalHandle | string>;

export function attachDriveBehaviorByCode(
  viewer: DriveBehaviorHostViewer,
  driveNode: Object3D,
  type?: 'Drive_DestinationMotor',
  wiring?: SignalWiring,
): RVDriveDestinationMotor | null;
export function attachDriveBehaviorByCode(
  viewer: DriveBehaviorHostViewer,
  driveNode: Object3D,
  type: 'Drive_Simple',
  wiring?: SignalWiring,
): RVDriveSimple | null;
export function attachDriveBehaviorByCode(
  viewer: DriveBehaviorHostViewer,
  driveNode: Object3D,
  type: 'Drive_FollowPosition',
  wiring?: SignalWiring,
): RVDriveFollowPosition | null;
export function attachDriveBehaviorByCode(
  viewer: DriveBehaviorHostViewer,
  driveNode: Object3D,
  type: AttachableDriveBehaviorType,
  wiring?: SignalWiring,
): RVComponent | null;
export function attachDriveBehaviorByCode(
  viewer: DriveBehaviorHostViewer,
  driveNode: Object3D,
  type: AttachableDriveBehaviorType = 'Drive_DestinationMotor',
  wiring?: SignalWiring,
): RVComponent | null {
  const signalStore = viewer.signalStore;
  const registry = viewer.registry;
  if (!signalStore || !registry) return null;

  const entry = DRIVE_BEHAVIOR_MAP[type];
  if (!entry) return null;
  const path = NodeRegistry.computeNodePath(driveNode);

  // R1 idempotency: a registered instance OR an rv_extras stamp means this drive
  // already carries the behavior → return the existing instance, attach nothing.
  const ud = driveNode.userData as { realvirtual?: Record<string, unknown> };
  const existing = registry.getByPath<RVComponent>(type, path);
  if (existing) return existing;
  const activeBehavior = Object.keys(ud.realvirtual ?? {}).find((key) => {
    const base = key.replace(/_\d+$/, '');
    return base !== 'Drive' && base.startsWith('Drive_');
  });
  if (activeBehavior && activeBehavior !== type) {
    console.error(
      `[DriveBehavior] Cannot attach "${type}" at "${path}": "${activeBehavior}" is already active; reload the model to change behavior`,
    );
    return null;
  }
  if (ud.realvirtual && ud.realvirtual[type]) {
    // Stamped but not registered (defensive) — nothing else to do without a
    // matching instance; the loader path would have registered it. Return null
    // so the caller doesn't assume a live monitor exists.
    return null;
  }

  // The drive must already exist (the loader built it before setup() runs).
  const drive = registry.getByPath<RVDrive>('Drive', path);
  if (!drive) return null;

  // Parity stamp: mark the node as carrying the behavior (GLB rv_extras shape),
  // so the binding-slot resolver, hierarchy badge, inspector and GLB export all
  // see it. Seeded with the schema's non-ref defaults so the inspector shows the
  // full field set exactly like an imported behavior. Empty signal slots stay
  // empty and are resolved through direct binding contracts.
  const extras: Record<string, unknown> = { ...getSchemaDefaults(type) };
  (ud.realvirtual ??= {})[type] = extras;

  // Construct + apply schema defaults (no GLB extras → schema defaults only).
  const inst = new entry.ctor(driveNode);
  const instRecord = inst as unknown as Record<string, unknown>;
  applySchema(instRecord, entry.schema, getSchemaDefaults(type));

  // Explicit wiring wins completely: the caller decides which signals exist.
  // ONLY the wired slots are connected; an unwired behavior remains signal-free
  // and exposes its schema slots through the direct command/feedback contracts.
  if (wiring) {
    for (const [slot, sig] of Object.entries(wiring)) {
      const sigPath = typeof sig === 'string' ? sig : sig.path;
      instRecord[slot] = sigPath;
      const plcType = entry.schema[slot]?.signal;
      if (plcType && !extras[slot]) extras[slot] = componentReference(sigPath, plcType);
    }
  }

  // Register under its type so the resolver's getByPath('<type>', path) finds it.
  registry.register(type, path, inst);

  // Loader STEP 2 parity: resolve explicitly wired refs
  // then init() so the feedback callback + input subscriptions are wired.
  const ctx: ComponentContext = {
    registry,
    signalStore,
    scene: viewer.scene,
    transportManager: (viewer.transportManager ?? undefined) as unknown as ComponentContext['transportManager'],
    root: driveNode,
    gizmoManager: viewer.gizmoManager,
    lampManager: viewer.lampManager,
  };
  resolveComponentRefs(instRecord, registry);
  inst.init(ctx);

  // Rebuild the suffix index so explicitly wired paths/subscriptions resolve.
  signalStore.buildIndex();

  return inst;
}
