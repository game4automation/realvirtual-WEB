// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-component-registry.ts — Component auto-mapping system for GLB extras.
 *
 * Each TypeScript component declares a static schema matching its C# counterpart.
 * Properties use exact C# PascalCase names: schema key = GLB extras key = TS property name = C# field name.
 * The loader auto-maps GLB extras to instance properties, resolves ComponentRefs, then calls init().
 *
 * Two-step loader model (like Unity Awake/Start):
 *   Step 1 "Awake": traverse + construct + applySchema + register ALL
 *   Step 2 "Start": resolveComponentRefs + init() ALL
 */

import { Vector3 } from 'three';
import type { Box3, Material, Object3D, Scene } from 'three';
import rvOdt from '../../../schema/v1/rv-odt.json';
import type { NodeRegistry, ComponentRef } from './rv-node-registry';
import type { SignalStore } from './rv-signal-store';
import type { RVTransportManager } from './rv-transport-manager';
import type { AABB } from './rv-aabb';
import type { GizmoOverlayManager } from './rv-gizmo-manager';
import type { LampManager } from './rv-lamp-manager';
import type { WebLabelManager } from './rv-web-label-manager';
import type { SceneButtonManager } from './rv-scene-button-manager';
import type { EnergyChainManager } from './rv-energy-chain-manager';
import type { ChainManager } from './rv-chain-manager';
import type { RibbonManager } from './rv-ribbon-manager';
import type { MachiningManager } from './rv-machining-manager';
import type { CollisionRoleRegistrar } from './rv-collision-role';
import type { KinematicManagerLike } from './rv-kinematic-registry';
import type { SignalReapplyRegistry } from './rv-signal-reapply-registry';
import type { RVOutlineManager } from './rv-outline-manager';
import type { ErrorStore } from './rv-error-store';
import type { RVHighlightManager } from './rv-highlight-manager';
import type { InstructionRuntimeStore } from './rv-instruction-runtime-store';
import type { ComponentEventDispatcher } from './rv-component-event-dispatcher';
import type { ObjectHoverData } from './rv-raycast-manager';
import type { EventEmitter } from '../rv-events';
import type { ViewerEvents } from '../rv-viewer-events';
import { isBakeRole, type BakeRole } from './rv-bake-chunk';

// ─── Schema Types ────────────────────────────────────────────────

export type FieldType = 'number' | 'boolean' | 'string' | 'vector3' | 'componentRef' | 'componentRefArray' | 'enum' | 'json';

/** PLC signal type a componentRef slot expects (Unity parity: the C# field type,
 *  e.g. `public PLCOutputBool Forward`). */
export type PlcSignalType =
  | 'PLCOutputBool' | 'PLCOutputFloat' | 'PLCOutputInt'
  | 'PLCInputBool'  | 'PLCInputFloat'  | 'PLCInputInt';

export interface FieldDescriptor {
  type: FieldType;
  default?: unknown;
  /**
   * For 'componentRef': declares the slot as a standard PLC signal of this type
   * — the transparent, in-component equivalent of the C# `public PLCOutputBool
   * Forward;` field. Signals exist only when the Unity export wired them, a
   * behavior created one via `addSignal`, or the author added one explicitly —
   * there is NO load-time auto-provisioning (plan-317). An unwired slot is
   * offered as a direct-property/direct-feedback binding slot instead.
   */
  signal?: PlcSignalType;
  /** For 'enum': maps GLB string → internal value */
  enumMap?: Record<string, unknown>;
  /** For 'vector3': apply Unity→glTF coordinate transform (negate X) */
  unityCoords?: boolean;
  /** Alternative GLB field names (legacy compat) */
  aliases?: string[];
  /** When true the field is displayed in the inspector but never editable — and
   *  the overlay/live-edit write paths refuse to mutate it (defense in depth). */
  readonly?: boolean;
  /**
   * Where the field has meaning. Default `'live'` = today's behavior. Orthogonal
   * to `readonly` (which only toggles editability of a field that is shown).
   *   'live' → editable inspector row, takes effect live (the rv_extras default).
   *   'des'  → DES-only config: shown as a read-only row tagged "(DES)" — inert in
   *            the continuous/live view, so editing it would be a lie. Treated
   *            exactly like `readonly` for editability + write guards, plus the
   *            "(DES)" label.
   *   'none' → no inspector row at all: not stamped as a default and not reported
   *            as a "consumed" field (no overlay path).
   */
  scope?: 'live' | 'des' | 'none';
  /**
   * The field is kept in the schema so an older document still validates, but it
   * drives nothing. The inspector HIDES such a row while the field is empty and
   * shows it read-only with a "(deprecated)" tag once a document actually
   * carries a value — so the user sees why the value has no effect instead of
   * being offered an editor for a dead field. Orthogonal to `readonly`/`scope`:
   * it changes only what the inspector renders, never the write guards, because
   * a migration tool must still be able to clear the value.
   */
  deprecated?: boolean;
  /**
   * Reference fields only (plan-754 D7): what this reference claims for its
   * TARGET node in the bake. Default `'merge'` — the target survives as a node,
   * its mesh is merged into the enclosing chunk. `'chunk'` makes the target a
   * chunk boundary (the referrer moves, hides or clones it as a unit). Never
   * `'keep'`: mesh ownership is always local to a component on the node itself.
   * Read through {@link bakeTargetOf}; the TS-side table
   * `REFERENCE_BAKE_TARGETS` (rv-bake-survival.ts) declares the tagged fields
   * because the generated rv-ODT schema does not carry this keyword (D15).
   */
  bakeTarget?: ReferenceBakeTarget;
  /**
   * Number fields (plan-512): unit of the value (UCUM-style, e.g. `mm`,
   * `mm/s2`, `s`). The SSOT of the inspector's unit suffix (`getFieldUnit`).
   */
  unit?: string;
  /**
   * Signal slots (`componentRef` + `signal`, plan-512): unit of the value on the
   * COMPONENT side of the slot — a literal (`'mm'`) or a quantity token
   * (`'@drive-position'`, `'@drive-speed'`, `'@drive-acceleration'`) resolved
   * through `Drive.Direction` of the carrying node.
   */
  signalUnit?: string;
  /**
   * Signal slots (plan-512): the sibling number field that carries the unit
   * factor of this slot (`Drive_FollowPosition.Position` → `Scale`). Binding a
   * signal with a known unit writes `conversion(signalUnit → slot unit)` there.
   */
  scaleField?: string;
}

/** What a reference claims for its target node in the bake (plan-754 D7). */
export type ReferenceBakeTarget = 'merge' | 'chunk';

/**
 * The single reader of {@link FieldDescriptor.bakeTarget}: `'merge'` unless the
 * descriptor says `'chunk'`. Undefined descriptor → `'merge'`.
 */
export function bakeTargetOf(desc?: FieldDescriptor): ReferenceBakeTarget {
  return desc?.bakeTarget === 'chunk' ? 'chunk' : 'merge';
}

/**
 * True when a field must be shown as read-only in the inspector: either the
 * descriptor explicitly marks it `readonly`, or its `scope` is `'des'` (DES-only
 * config has no live effect, so it is never editable). The single predicate the
 * inspector editability gate and the overlay/live-edit write guards share, so
 * `scope:'des'` blocks writes exactly like `readonly:true`. A `scope:'none'`
 * field is filtered out upstream (never stamped, never consumed) and never reaches
 * this predicate. Undefined descriptor → not read-only (backward compatible).
 */
export function isFieldDisplayReadonly(desc?: FieldDescriptor): boolean {
  return desc?.readonly === true || desc?.scope === 'des';
}

export type ComponentSchema = Record<string, FieldDescriptor>;

// ─── rv-ODT Spec Loading ─────────────────────────────────────────

/** Raw JSON property definition inside an rv-odt.json component `$def`. */
export interface OdtProperty {
  type?: string;
  $ref?: string;
  items?: { $ref?: string; type?: string };
  enum?: string[];
  /** Informative field description (single source for tooltips and tools). */
  description?: string;
  /** Custom keyword (plan-517): component type a non-signal ComponentReference
   *  targets (`TransportSurface.DriveReference` → `Drive`). Metadata only — the
   *  runtime mapper below does not read it. */
  refType?: string;
  /** Custom keyword: explicit wire-value → internal-value map (non-identity enums). */
  enumMap?: Record<string, unknown>;
  default?: unknown;
  /** Custom keyword: PLC signal type of a ComponentReference slot. */
  signal?: string;
  /** Custom keyword: Unity→glTF coordinate transform (negate X) on Vector3 refs. */
  unityCoords?: boolean;
  /** Custom keyword: field is displayed but never editable. */
  readonly?: boolean;
  /** Custom keyword: field scope ('live' | 'des' | 'none'). */
  scope?: string;
  /** Custom keyword: field is kept for compatibility but drives nothing. */
  deprecated?: boolean;
  /** Custom keyword: UCUM-style unit of a number field (plan-512: SSOT of the inspector suffix). */
  unit?: string;
  /** Custom keyword: unit of a signal slot's value on the component side (literal or `@drive-*` token). */
  signalUnit?: string;
  /** Custom keyword: sibling number field carrying a signal slot's unit factor. */
  scaleField?: string;
}

export interface OdtComponentDef {
  /** Informative description of the component type. */
  description?: string;
  properties?: Record<string, OdtProperty>;
  /** Custom keyword: primary field name → array of legacy GLB field names. */
  aliases?: Record<string, string[]>;
}

const ODT_DEFS = (rvOdt as unknown as { $defs: Record<string, OdtComponentDef> }).$defs;

/** The rv-ODT index groups (`components`, `structure`, …) that list spec'd types. */
const ODT_INDEX_GROUPS = ['components', 'structure', 'signals', 'logicSteps', 'recording', 'connections'] as const;

/**
 * The RAW rv-ODT `$def` of a type — every keyword as written in rv-odt.json
 * (descriptions, raw `enum`, `unit`, `refType`, …), or `undefined` when the
 * schema has no such def. Read-only metadata access for tools that describe
 * the format (plan-517 `web_component_schema`); deliberately separate from
 * {@link loadSchemaFromSpec}, whose output is frozen by a baseline and must not
 * grow description or reference metadata.
 */
export function getRawOdtDef(type: string): Readonly<OdtComponentDef> | undefined {
  return Object.prototype.hasOwnProperty.call(ODT_DEFS, type) ? ODT_DEFS[type] : undefined;
}

/** The rv-ODT index group (`components`, `structure`, …) that lists `type`, or null. */
export function getOdtIndexGroup(type: string): string | null {
  const doc = rvOdt as unknown as Record<string, Record<string, unknown> | undefined>;
  for (const group of ODT_INDEX_GROUPS) {
    const index = doc[group];
    if (index && Object.prototype.hasOwnProperty.call(index, type)) return group;
  }
  return null;
}

/**
 * Build a runtime ComponentSchema from the rv-ODT specification (schema/v1/rv-odt.json).
 *
 * The JSON file is the single source of truth for component field definitions
 * (realvirtual Open Digital Twin Format, plan-187). Components declare
 * `static readonly schema = loadSchemaFromSpec('<RegistryKey>')` instead of an
 * inline object — the result is semantically identical to the previous inline
 * definitions (guarded by tests/spec-loading.test.ts against a frozen baseline).
 *
 * Enum handling: GLB persists enum values as strings. When the JSON property
 * carries a custom `enumMap` keyword (non-identity mapping, e.g. legacy integer
 * indices or lowercase internal values), it is used verbatim; otherwise the
 * `enum` array produces a string→string identity map.
 */
export function loadSchemaFromSpec(name: string): ComponentSchema {
  const def = ODT_DEFS?.[name];
  if (!def) throw new Error(`rv-ODT spec has no $def "${name}"`);

  const out: ComponentSchema = {};
  for (const [field, p] of Object.entries(def.properties ?? {})) {
    let desc: FieldDescriptor;

    if (p.$ref === '#/$defs/ComponentReference') {
      desc = { type: 'componentRef' };
      if (typeof p.signal === 'string') desc.signal = p.signal as PlcSignalType;
    } else if (p.$ref === '#/$defs/Vector3') {
      desc = { type: 'vector3' };
      if (p.unityCoords === true) desc.unityCoords = true;
    } else if (p.type === 'array' && p.items?.$ref === '#/$defs/ComponentReference') {
      desc = { type: 'componentRefArray' };
    } else if (Array.isArray(p.enum) || p.enumMap) {
      const enumMap: Record<string, unknown> = {};
      if (p.enumMap && typeof p.enumMap === 'object') {
        Object.assign(enumMap, p.enumMap);
      } else {
        for (const v of p.enum ?? []) enumMap[v] = v;
      }
      desc = { type: 'enum', enumMap };
    } else if (p.type === 'number' || p.type === 'boolean' || p.type === 'string') {
      desc = { type: p.type };
    } else if (p.type === 'array' || p.type === 'object') {
      // Structured JSON field (e.g. Path.segments) — carried verbatim; the
      // component's own parser is the SSOT for the inner shape. Generic on
      // purpose: any component can declare structured fields this way and gets
      // inspector + overlay + MCP editability without a dedicated tool.
      desc = { type: 'json' };
    } else {
      throw new Error(`rv-ODT spec: unsupported property type for ${name}.${field}`);
    }

    if (p.default !== undefined) {
      // Enum defaults are written in the JSON as WIRE values ("Info"); resolve
      // them through the enumMap to the internal runtime value ('info').
      if (desc.type === 'enum' && desc.enumMap && typeof p.default === 'string' && p.default in desc.enumMap) {
        desc.default = desc.enumMap[p.default];
      } else {
        desc.default = p.default;
      }
    }
    if (p.readonly === true) desc.readonly = true;
    if (p.deprecated === true) desc.deprecated = true;
    if (p.scope === 'live' || p.scope === 'des' || p.scope === 'none') desc.scope = p.scope;
    // plan-512: unit metadata. `unit` only on scalar number fields (a Vector3's
    // `unit` documents its components and never feeds a suffix or a factor).
    if (typeof p.unit === 'string' && p.unit && desc.type === 'number') desc.unit = p.unit;
    if (desc.type === 'componentRef' && desc.signal) {
      if (typeof p.signalUnit === 'string' && p.signalUnit) desc.signalUnit = p.signalUnit;
      if (typeof p.scaleField === 'string' && p.scaleField) desc.scaleField = p.scaleField;
    }

    out[field] = desc;
  }

  // Aliases live in a top-level "aliases" object on the component $def:
  // primary field name → array of legacy GLB field names (multi-alias capable).
  if (def.aliases) {
    for (const [primaryField, aliasList] of Object.entries(def.aliases)) {
      if (out[primaryField] && Array.isArray(aliasList)) {
        out[primaryField].aliases = aliasList;
      }
    }
  }
  return out;
}

/** Context passed to component init() — component decides how to use it */
export interface ComponentContext {
  registry: NodeRegistry;
  signalStore: SignalStore;
  scene: Scene;
  transportManager: RVTransportManager;
  /** Root of the loaded GLB scene (needed by Source for spawnParent) */
  root: Object3D;
  /** Optional — available when RVViewer instantiates one. Components that need
   *  overlays (e.g. WebSensor) must null-check before use. */
  gizmoManager?: GizmoOverlayManager;
  /** Optional viewer-owned registry for fixed-update Lamp flashing. */
  lampManager?: LampManager;
  /** Optional viewer-owned registry for `WebLabel` components (plan-529): the
   *  render-path screen-size / fade / toggle pass and the label link clicks.
   *  Absent → a label is built at a fixed size and never fades. */
  webLabelManager?: WebLabelManager;
  /** Optional viewer-owned registry for 3D scene buttons (plan-417): press/turn
   *  animation, momentary-click timers and the component lifecycle. Components
   *  that animate a button cap must null-check before use. */
  sceneButtonManager?: SceneButtonManager;
  /** Optional — the viewer's OutlinePass wrapper. Components that drive the
   *  status outline (CustomRuntimeInstruction step highlight) must null-check
   *  before use. */
  outlineManager?: RVOutlineManager;
  /** Optional — central error/alarm registry (RVViewer singleton). Components
   *  that report errors (e.g. WebError) must null-check before use. */
  errorStore?: ErrorStore;
  /** Optional — central runtime-instruction registry (RVViewer singleton).
   *  Components that push instructions (CustomRuntimeInstruction) must null-check
   *  before use. */
  instructionStore?: InstructionRuntimeStore;
  /** Optional — the viewer's highlight pipeline (hover / selection / aux /
   *  flash channels, chunk-aware). A component that marks its own node
   *  (WebError: persistent red X-ray overlay + one alarm flash on activation)
   *  uses it instead of per-mesh gizmo copies. Must null-check before use. */
  highlighter?: RVHighlightManager;
  /** Optional — available when RVViewer instantiates one. Components don't
   *  need to touch this directly; they just implement onHover/onClick/onSelect. */
  componentEventDispatcher?: ComponentEventDispatcher;
  /** Optional — viewer event bus for cross-component / UI↔engine signaling. */
  events?: EventEmitter<ViewerEvents>;
  /**
   * Optional viewer-owned registry for EnergyChain components (plan-362).
   * Components that build a runtime rig must null-check before use.
   */
  energyChainManager?: EnergyChainManager;
  /**
   * Optional viewer-owned registry for `Chain` components (plan-733). `RVChain`
   * registers itself here so `CoreSubsystems.visuals()` can pose its elements
   * after the drive stage, and so `resetSimulation()` can re-pose them AFTER the
   * drive resets. Absent → the chain is built and placed but never ticks.
   */
  chainManager?: ChainManager;
  /**
   * Optional viewer-owned registry for `RibbonPath` components (plan-459). An
   * `RVRibbonPath` registers itself here so `CoreSubsystems.visuals()` can advance
   * the web AFTER the drive stage — which is also what lets the winder-master
   * mode read a rotational drive without an `IDriveBehavior`. Absent → the web
   * is built and shaped correctly but never runs.
   */
  ribbonManager?: RibbonManager;
  /**
   * Optional viewer-owned CSG machining registry (plan-405). `MachiningVolume`
   * components register themselves here in `onSceneReady()` (after Kinematic
   * re-parenting, so tool nodes are in their final hierarchy position); every
   * other component ignores it. Absent → no machining at all: the authored
   * workpiece mesh stays visible and untouched (F10).
   */
  machiningManager?: MachiningManager;
  /**
   * Optional viewer-owned collision registry (plan-394). `CollisionRole`
   * components register their node here; every other component ignores it.
   * Typed as the narrow registrar interface so the context does not drag in
   * the manager implementation.
   */
  collisionManager?: CollisionRoleRegistrar;
  /**
   * Optional rigid-body mechanism manager (plan-404). Set from the module
   * singleton `getKinematicManager()` on EVERY context construction path
   * (initial load, processExtras/asset placement, createRuntimeNode,
   * constructComponentOnNode) — the lifecycle matrix in plan-404 §2.3 requires
   * a mechanism created on any path to reach the tick loop. Undefined in a
   * public build, where the private manager was never installed; the mechanism
   * components themselves are absent there too, so nothing reads it.
   */
  kinematicManager?: KinematicManagerLike;
  /**
   * Optional viewer-owned re-apply registry (plan-427). Components pass it as
   * the last argument of the `wireXSignal` helpers so their input slots can be
   * re-driven with the CURRENT signal level after `resetSimulation()` and after
   * a reconnect — the edge-driven store alone never repeats a held level.
   *
   * Set on EVERY context construction path; where no option bag carries it, the
   * module slot `getActiveSignalReapplyRegistry()` fills in (same rationale as
   * `kinematicManager` above). Undefined only in pure unit tests, where the
   * helpers then behave exactly as before the feature.
   */
  reapply?: SignalReapplyRegistry;
  /**
   * True when this context belongs to a load path that WILL still call
   * `onSceneReady()` — `loadGLB` and `processExtras`. Both run the Kinematic
   * re-parenting pass BETWEEN `init()` and `onSceneReady()`, so a component
   * that freezes a bind frame (EnergyChain) must wait: rigging in `init()`
   * would capture the PRE-reparent hierarchy and, being idempotent, never
   * correct itself. `createRuntimeNode` / `constructComponentOnNode` leave this
   * unset — there is provably no `onSceneReady` pass on those paths and no
   * re-parenting left to happen, so they rig immediately in `init()`.
   */
  expectSceneReady?: boolean;
  /**
   * True on an AUTHORING load — the asset editor, which saves back the tree it
   * sees (plan-733 R4). Fed from `preserveAuthoringHierarchy`, NOT from
   * `preserveHierarchy`: that one is a mesh-bake flag which the simulating embed
   * runtime sets too (see the note on `LoadGLBOptions.preserveAuthoringHierarchy`).
   *
   * Components that MATERIALISE runtime geometry from their configuration must
   * skip that work here: `RVChain` would otherwise clone `NumberOfElements`
   * copies of its template into the document, the save would bake them in, and
   * the next round trip would clone N per baked copy. The prune allowlist in
   * `rv-asset-glb-export.ts` is the second half of the defence, not a substitute
   * — a marker only helps for geometry that reaches the export path at all.
   */
  authoring?: boolean;
}

/** Interface all auto-mapped components implement */
export interface RVComponent {
  readonly node: Object3D;
  /** True when this component owns its simulation (local authority).
   *  Set to false by MultiuserPlugin when server is authority. Default: true. */
  isOwner: boolean;
  init(context: ComponentContext): void;
  /** Optional second-pass init, called by the scene loader AFTER the Kinematic
   *  re-parenting pass (Phase 8b). Use this when the component needs the final
   *  child hierarchy — e.g. to compute an AABB that includes meshes which are
   *  re-parented under this node by Kinematic groups. */
  onSceneReady?(context: ComponentContext): void;
  dispose?(): void;
  /** Called when ownership changes (e.g. multiuser connect/disconnect).
   *  Components self-manage their multiuser behavior in this callback. */
  onOwnershipChanged?(isOwner: boolean): void;

  /** Optional: authoritative current runtime values, keyed by the SAME
   *  PascalCase display/schema names. This is the single source of truth the
   *  UI (inspector, hierarchy badges, tooltips) reads for live state — it
   *  overrides the static GLB config and any overlay edit. Components without
   *  runtime state omit this method (their values come from static config).
   *  Must be a cheap, allocation-light, read-only snapshot. */
  getLiveState?(): Record<string, unknown>;

  /** Optional: apply an inspector edit to the live runtime state and return
   *  true if handled. Implement this when a field has a config↔runtime split
   *  (e.g. Drive's `TargetSpeed` config vs `targetSpeed` runtime) so editing it
   *  takes effect immediately. Return false to let the caller fall back to a
   *  plain same-named field assignment. */
  setLiveField?(fieldName: string, value: unknown): boolean;

  /** Optional: re-derive runtime state from config fields after a live edit has
   *  written new schema values onto the instance (e.g. Drive recomputing its
   *  axis / isRotary from Direction). Called by the SceneStore op executor after
   *  re-applying the schema, mirroring the scene loader's overlay reconciliation.
   *  Must be safe to call post-load (do NOT re-cache base transforms or reset
   *  runtime position). Components whose config fields take effect on read omit
   *  this. */
  reapplyConfig?(): void;

  // ── Optional component-level event callbacks (dispatched by
  //    ComponentEventDispatcher). Components opt in by implementing any of these.
  /** Called when this component's node is hovered (true) or un-hovered (false). */
  onHover?(hovered: boolean, event?: ObjectHoverData): void;
  /** Called when this component's node is clicked. Payload from 'object-clicked'. */
  onClick?(event: { path: string; node: Object3D }): void;
  /** Called when this component's node enters (true) or leaves (false) the selection. */
  onSelect?(selected: boolean): void;
}

// ─── Schema Application ─────────────────────────────────────────

/**
 * Apply a component schema to an instance, mapping GLB extras → instance properties.
 * Schema key = property name = C# name. No conversion needed.
 *
 * Field types:
 * - number: coerce to Number
 * - boolean: coerce to Boolean
 * - string: coerce to String
 * - vector3: create THREE.Vector3 (with optional Unity→glTF coord transform)
 * - componentRef: preserve raw ComponentRef object for later resolution
 * - enum: lookup via enumMap
 *
 * When a field is missing/null in extras, the schema default is applied.
 * Aliases are checked when the primary key is missing.
 */
export function applySchema(
  instance: Record<string, unknown>,
  schema: ComponentSchema,
  extras: Record<string, unknown>,
): void {
  for (const key of Object.keys(schema)) {
    const desc = schema[key];

    // Find value: primary key first, then aliases
    let raw = extras[key];
    if ((raw === undefined || raw === null) && desc.aliases) {
      for (const alias of desc.aliases) {
        const aliasVal = extras[alias];
        if (aliasVal !== undefined && aliasVal !== null) {
          raw = aliasVal;
          break;
        }
      }
    }

    // Use default when missing/null
    if (raw === undefined || raw === null) {
      if (desc.default !== undefined) {
        if (desc.type === 'vector3' && desc.default instanceof Vector3) {
          instance[key] = (desc.default as Vector3).clone();
        } else if (desc.type === 'json') {
          // Deep-copy — a shared mutable default (array/object) across
          // instances would let one instance's edit leak into every other.
          instance[key] = structuredClone(desc.default);
        } else {
          instance[key] = desc.default;
        }
      }
      // componentRef with no value stays as-is (null on instance)
      continue;
    }

    // Coerce by type
    switch (desc.type) {
      case 'number':
        instance[key] = Number(raw);
        break;

      case 'boolean':
        instance[key] = Boolean(raw);
        break;

      case 'string':
        instance[key] = String(raw);
        break;

      case 'vector3': {
        const v = raw as { x?: number; y?: number; z?: number };
        const x = v.x ?? 0;
        const y = v.y ?? 0;
        const z = v.z ?? 0;
        if (desc.unityCoords) {
          // Unity LHS → glTF RHS: negate X
          instance[key] = new Vector3(-x, y, z);
        } else {
          instance[key] = new Vector3(x, y, z);
        }
        break;
      }

      case 'componentRef':
        // Preserve raw ComponentRef for later resolution by resolveComponentRefs()
        instance[key] = raw;
        break;

      case 'componentRefArray':
        // Preserve raw ComponentRef array for later resolution by resolveComponentRefs()
        instance[key] = Array.isArray(raw) ? raw : [];
        break;

      case 'enum': {
        const enumMap = desc.enumMap;
        if (enumMap && typeof raw === 'string' && raw in enumMap) {
          instance[key] = enumMap[raw];
        } else if (desc.default !== undefined) {
          instance[key] = desc.default;
        }
        break;
      }

      case 'json':
        // Verbatim deep copy — the component's parser validates the shape.
        instance[key] = structuredClone(raw);
        break;
    }
  }
}

// ─── Component Reference Resolution ────────────────────────────

/**
 * Scan instance properties for raw ComponentRef objects and resolve them.
 *
 * Signal refs (PLCOutputBool, PLCInputBool, etc.) → resolved signal address string
 * Sensor refs → RVSensor instance
 * Drive refs → RVDrive instance
 * Any other REGISTERED component type → that instance (plan-411 §2.2)
 * Unresolvable refs → null (does not throw); inside an ARRAY the raw path is
 *   kept instead, because array consumers resolve late.
 * Primitive fields are left untouched.
 */
export function resolveComponentRefs(
  instance: Record<string, unknown>,
  registry: NodeRegistry,
  /**
   * plan-757 F7: the asset the component was authored in (its subtree root).
   * The ONE resolver reads every reference relative to it first — as written,
   * then with the asset root's name stripped — so the same asset-relative
   * `Mount/Kine` binds inside the main model and inside each of ten placements.
   */
  scope?: Object3D | null,
): void {
  // Array fields are collected first and written back whole, so a consumer
  // never sees a half-resolved array.
  const arrays = new Map<string, unknown[]>();
  forEachComponentRef(instance, (key, ref, index) => {
    const res = registry.resolve(ref, scope);
    if (index === null) {
      if (res.signalAddress !== undefined) {
        instance[key] = res.signalAddress;
      } else if (res.sensor !== undefined) {
        instance[key] = res.sensor;
      } else if (res.drive !== undefined) {
        instance[key] = res.drive;
      } else if (res.node !== undefined) {
        // Generic node ref (Unity `Transform` field, plan-362). A resolved node
        // must NOT be flattened to null by the fallthrough below.
        instance[key] = res.node;
      } else if (res.component !== undefined) {
        // Generic registered component (plan-411 §2.2) — e.g. a
        // `realvirtual.KinematicMechanism` reference, which used to land in the
        // null fallthrough below and forced a per-component path workaround.
        instance[key] = res.component;
      } else {
        // Unresolvable — set to null rather than throwing
        instance[key] = null;
      }
      return;
    }
    // Element of a componentRefArray: non-ref elements stay as they are.
    let out = arrays.get(key);
    if (!out) {
      out = [...(instance[key] as unknown[])];
      arrays.set(key, out);
    }
    if (res.signalAddress !== undefined) {
      out[index] = res.signalAddress;
    } else if (res.sensor !== undefined) {
      out[index] = res.sensor;
    } else if (res.drive !== undefined) {
      out[index] = res.drive;
    } else if (res.node !== undefined) {
      out[index] = res.node;
    } else if (res.component !== undefined) {
      // Generic registered component (plan-411 §2.2) — same treatment as
      // a Drive/Sensor element, so an array of mechanism/tool references
      // arrives as instances rather than as strings the consumer has to
      // resolve a second time.
      out[index] = res.component;
    } else {
      // Keep the raw ref path for DES component resolution
      out[index] = ref.path;
    }
  });
  for (const [key, out] of arrays) instance[key] = out;
}

/**
 * THE iterator over raw ComponentReference values of one record (plan-754):
 * a component INSTANCE right after `applySchema` (what
 * {@link resolveComponentRefs} walks) or a component's raw rv extras block
 * (what the bake survival model walks — no instance exists at that point).
 * Visits top-level scalar refs (`index === null`) and the ref elements of
 * top-level arrays (`index` = element position; non-ref elements are
 * skipped). Nested objects are not descended — same reach as before the
 * factoring. The callback may assign `record[key]` for scalar fields; array
 * fields must be written back after the walk.
 */
export function forEachComponentRef(
  record: Record<string, unknown>,
  visit: (key: string, ref: ComponentRef, index: number | null) => void,
): void {
  for (const key of Object.keys(record)) {
    const val = record[key];
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) {
        if (isComponentRef(val[i])) visit(key, val[i] as ComponentRef, i);
      }
      continue;
    }
    if (isComponentRef(val)) visit(key, val as ComponentRef, null);
  }
}

/** Check if a value looks like a raw ComponentRef from GLB extras */
function isComponentRef(val: unknown): boolean {
  if (val === null || val === undefined || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return obj['type'] === 'ComponentReference' && typeof obj['path'] === 'string';
}

// ─── Component Capabilities (plan-753 §2.3) ─────────────────────

/**
 * How the pointer interacts with nodes of this type.
 *   'none'   — invisible to hover/click (data-only components, structure).
 *   'select' — hover + tooltip + click selects the node (the ordinary component).
 *   'action' — hover + click fires `component.onClick` WITHOUT selecting the
 *              node (3D buttons, switches, doors). Until the chunk pick backend
 *              lands (plan-753 Phase 3) the gate treats it like 'select'.
 */
export type PickMode = 'none' | 'select' | 'action';

/** UI-facing declarations — hierarchy badge, filter dropdown, tooltip, inspector. */
export interface ComponentUiCapabilities {
  /** Badge color (hex) in the hierarchy browser. Default: {@link DEFAULT_BADGE_COLOR} */
  badge?: string;
  /** Label in the search/filter dropdown and the visibility auto-filters; also
   *  the membership test of the exclusive hover mode. null = not filterable. */
  filter?: string | null;
  /** Coarse category id for the hierarchy filter chips and the search grouping
   *  (plan-597; ids in `CATEGORY_ORDER`, rv-component-category.ts). The
   *  `filter` label is the fine second level inside the category. null = derive
   *  (built-in rule, else 'other'); an unknown id is normalised to 'other'. */
  category?: string | null;
  /** Tooltip content type (key in tooltip-registry). null = no tooltip. */
  tooltip?: string | null;
  /** Tooltip section priority — LOWER renders first in the bubble (hover AND pinned). Default: 5 */
  priority?: number;
  /** Hide the component from the Property Inspector and the hierarchy chips. Default: false */
  hidden?: boolean;
}

/**
 * What an `onPreBake` hook may touch (plan-754 D18). The hook runs on the RAW
 * temporary graph BEFORE the bake, so no component instance, no signal store
 * and no live registry exist yet — extras and tree only.
 */
export interface PreBakeContext {
  /** Root of the temporary graph the hooks run on (`tmp`). */
  root: Object3D;
  /** Path → node on `tmp`, resolved by the same rule as `NodeRegistry.getNode`. */
  resolvePath(path: string): Object3D | null;
  /** Bounds of a node's own/child source meshes in the NODE's local frame — the
   *  ONLY sanctioned geometry read. `null` when the subtree draws nothing. */
  localBounds(node: Object3D): Box3 | null;
  /** Register a material object the template must carry (RibbonPath donor). */
  keepMaterial(id: string, material: Material): void;
  /** Record a subtree a hook re-parented, so the loader can keep the authored
   *  path resolvable as an alias after the registry is built. */
  notifyReparented(node: Object3D, previousPath: string): void;
}

/**
 * Structural preparation on the raw tree before the bake (plan-754 D18). May
 * re-parent nodes and write PLAIN-DATA numbers into `extras`; must NOT resolve
 * other components, read signals or keep references to anything. Runs once per
 * asset, in the `prepare` step of the pipeline.
 */
export type PreBakeHook = (
  node: Object3D,
  extras: Record<string, unknown>,
  ctx: PreBakeContext,
) => void;

/** Capabilities that a component type can declare. */
export interface ComponentCapabilities {
  /** Pointer interaction. Default: 'none' */
  pick?: PickMode;
  /** Bake role of the node's meshes (see rv-bake-chunk.ts). Default: 'merge' */
  bake?: BakeRole;
  /** UI declarations (badge, filter, tooltip, priority, hidden). */
  ui?: ComponentUiCapabilities;
  /** Component can be ADDED to nodes in the asset editor ("Add Component"
   *  inspector section). Requires a complete schema (initial field values
   *  come from `getSchemaDefaults`). Default: false */
  authorable?: boolean;
  /** plan-754 D18 — see {@link PreBakeHook}. Default: none. */
  onPreBake?: PreBakeHook;
  /** plan-755 D7 — does a component of this type keep its node alive through a
   *  destructive bake? Default: true. `false` = pure annotation (`Group`, the
   *  Unity export markers `renderer` / `colliders` / …): the node survives only
   *  for ANOTHER reason — reference target, plugin claim, `Snap-*`, keep mesh,
   *  ancestor of a survivor — and otherwise DISAPPEARS from every baked model.
   *  Read through {@link claimsNodeOf}, which also resolves `_N` dedup keys. */
  claimsNode?: boolean;
  /**
   * plan-756 F9 — does a component of this type REWRITE the geometry of its
   * meshes at runtime (CSG workpiece, ribbon band, energy-chain rig)? Such a
   * `bake:'keep'` mesh gets no cached pick structure; it is brute-forced inside
   * its CURRENT bounding box, because any structure would describe the geometry
   * of the previous tick. Default: false.
   */
  dynamicGeometry?: boolean;
}

/** Fully resolved form every consumer reads — no optional field left. */
export interface ResolvedCapabilities {
  readonly pick: PickMode;
  readonly bake: BakeRole;
  readonly ui: Readonly<Required<ComponentUiCapabilities>>;
  readonly authorable: boolean;
  readonly onPreBake: PreBakeHook | null;
  readonly claimsNode: boolean;
  readonly dynamicGeometry: boolean;
}

export const DEFAULT_BADGE_COLOR = '#90a4ae';
export const DEFAULT_UI_PRIORITY = 5;

/** Conservative defaults — nothing enabled, visible, merged into the enclosing chunk. */
export const DEFAULT_CAPABILITIES: ResolvedCapabilities = Object.freeze({
  pick: 'none' as PickMode,
  bake: 'merge' as BakeRole,
  ui: Object.freeze({
    badge: DEFAULT_BADGE_COLOR,
    filter: null as string | null,
    category: null as string | null,
    tooltip: null as string | null,
    priority: DEFAULT_UI_PRIORITY,
    hidden: false,
  }),
  authorable: false,
  onPreBake: null as PreBakeHook | null,
  claimsNode: true,
  dynamicGeometry: false,
});

// ── Registry ────────────────────────────────────────────────────

/** Separate Map for Capabilities (contains Factory-registered AND standalone entries). */
const capabilitiesMap = new Map<string, ResolvedCapabilities>();

/**
 * Monotonic counter, bumped on EVERY change of {@link capabilitiesMap}
 * (`registerCapabilities` — and through it `registerComponent` /
 * `registerComponentSchema` with capabilities —, `registerPreBakeHook` and the
 * test reset). Deliberately separate from the schema epoch: a direct
 * `registerCapabilities` call registers no schema (plan-597). A cache token for
 * derivations such as `categoryOf()`, not an identity.
 */
let _capabilitiesEpoch = 0;

/** Current capability-registration epoch (plan-597). */
export function getCapabilitiesEpoch(): number {
  return _capabilitiesEpoch;
}

/** Merge a normalized declaration with the defaults into the frozen resolved form. */
function resolveCapabilities(caps: ComponentCapabilities): ResolvedCapabilities {
  return Object.freeze({
    pick: caps.pick ?? DEFAULT_CAPABILITIES.pick,
    bake: caps.bake ?? DEFAULT_CAPABILITIES.bake,
    ui: Object.freeze({
      badge: caps.ui?.badge ?? DEFAULT_CAPABILITIES.ui.badge,
      filter: caps.ui?.filter ?? DEFAULT_CAPABILITIES.ui.filter,
      category: caps.ui?.category ?? DEFAULT_CAPABILITIES.ui.category,
      tooltip: caps.ui?.tooltip ?? DEFAULT_CAPABILITIES.ui.tooltip,
      priority: caps.ui?.priority ?? DEFAULT_CAPABILITIES.ui.priority,
      hidden: caps.ui?.hidden ?? DEFAULT_CAPABILITIES.ui.hidden,
    }),
    authorable: caps.authorable ?? DEFAULT_CAPABILITIES.authorable,
    onPreBake: caps.onPreBake ?? DEFAULT_CAPABILITIES.onPreBake,
    claimsNode: caps.claimsNode ?? DEFAULT_CAPABILITIES.claimsNode,
    dynamicGeometry: caps.dynamicGeometry ?? DEFAULT_CAPABILITIES.dynamicGeometry,
  });
}

/**
 * Attach an {@link PreBakeHook} to a type that registered its capabilities
 * elsewhere (plan-754 D18). Separate from {@link registerCapabilities} because
 * the hook of a structural type (`Kinematic`, `Group`) lives with the pass it
 * replaces, not with the badge declaration. Overwrites silently — a hook is
 * code, not configuration, and re-registration is how HMR re-installs it.
 */
export function registerPreBakeHook(type: string, hook: PreBakeHook): void {
  const current = capabilitiesMap.get(type) ?? DEFAULT_CAPABILITIES;
  capabilitiesMap.set(type, Object.freeze({ ...current, onPreBake: hook }));
  _capabilitiesEpoch++;
}

/** The pre-bake hook of a type, or null. */
export function preBakeHookOf(type: string): PreBakeHook | null {
  return capabilitiesMap.get(type)?.onPreBake ?? null;
}

/** Register capabilities for a type (standalone, without factory). */
export function registerCapabilities(
  type: string,
  capabilities: ComponentCapabilities,
): void {
  if (import.meta.env.DEV && capabilitiesMap.has(type)) {
    console.warn(`[rv] Capabilities for '${type}' already registered — overwriting`);
  }
  capabilitiesMap.set(type, resolveCapabilities(capabilities));
  _capabilitiesEpoch++;
}

/** Reset all capability registrations (test-only). */
export function _resetCapabilitiesForTesting(): void {
  capabilitiesMap.clear();
  _capabilitiesEpoch++;
}

/** Get resolved capabilities for a type. Returns defaults for unknown types. */
export function getCapabilities(type: string): ResolvedCapabilities {
  return capabilitiesMap.get(type) ?? DEFAULT_CAPABILITIES;
}

/**
 * plan-755 D7 — does a component under extras key `key` keep its node alive
 * through a destructive bake ({@link ComponentCapabilities.claimsNode})?
 *
 * Extras keys follow the `_N` dedup convention (`Group`, `Group_1`, `Group_2`,
 * …): a second `Group` on one node is the SAME annotation, so a key with no
 * registration of its own falls back to its base type (`/_\d+$/` stripped —
 * the rule `buildGroups` / `collectGroups` use). The exact key wins, so a type
 * that really is called `Foo_1` keeps its own declaration. An unknown type
 * claims (conservative default: it may still be addressed by path at runtime).
 *
 * Deliberately NOT applied to `bakeRoleOf` / `pickModeOf`: those stay
 * exact-key, so a `Drive_1` block still carries no role of its own — this
 * helper only answers the survival question. Allocation-free on the exact hit.
 */
export function claimsNodeOf(key: string): boolean {
  const exact = capabilitiesMap.get(key);
  if (exact) return exact.claimsNode;
  const base = key.replace(/_\d+$/, '');
  if (base === key) return DEFAULT_CAPABILITIES.claimsNode;
  return (capabilitiesMap.get(base) ?? DEFAULT_CAPABILITIES).claimsNode;
}

/** All registered types whose resolved capabilities satisfy `pred`. */
export function getTypesWhere(pred: (caps: ResolvedCapabilities) => boolean): string[] {
  const result: string[] = [];
  for (const [type, caps] of capabilitiesMap) {
    if (pred(caps)) result.push(type);
  }
  return result;
}

/**
 * Types with a top-level capability "on": `'pick'` = any mode but 'none',
 * `'bake'` = any role but 'merge', `'authorable'` = true.
 */
export function getTypesWithCapability(cap: 'pick' | 'bake' | 'authorable'): string[] {
  if (cap === 'pick') return getTypesWhere((c) => c.pick !== 'none');
  if (cap === 'bake') return getTypesWhere((c) => c.bake !== 'merge');
  return getTypesWhere((c) => c.authorable);
}

/** All types the pointer can interact with (`pick !== 'none'`). */
export function getPickableTypes(): string[] {
  return getTypesWhere((c) => c.pick !== 'none');
}

/** All types that appear in the filter dropdown / auto-filters (`ui.filter` set). */
export function getFilterableTypes(): string[] {
  return getTypesWhere((c) => c.ui.filter !== null);
}

/** Get all registered capabilities as a ReadonlyMap. */
export function getRegisteredCapabilities(): ReadonlyMap<string, ResolvedCapabilities> {
  return capabilitiesMap;
}

/** The UI declarations of a type (defaults for unknown types). */
export function uiOf(type: string): Readonly<Required<ComponentUiCapabilities>> {
  return getCapabilities(type).ui;
}

const PICK_RANK: Record<PickMode, number> = { none: 0, select: 1, action: 2 };

/**
 * Pick mode of a type, or the STRONGEST pick mode across every component on a
 * node (`action` > `select` > `none`). Reads `node.userData.realvirtual`; a node
 * without registered components is 'none'. Allocation-free — safe on the hover path.
 */
export function pickModeOf(typeOrNode: string | Object3D): PickMode {
  if (typeof typeOrNode === 'string') return getCapabilities(typeOrNode).pick;
  const rv = typeOrNode.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return 'none';
  let best: PickMode = 'none';
  for (const key in rv) {
    if (!rv[key]) continue;
    const caps = capabilitiesMap.get(key);
    if (!caps) continue;
    if (PICK_RANK[caps.pick] > PICK_RANK[best]) best = caps.pick;
  }
  return best;
}

/** rv extras key that overrides the type-declared bake role on ONE node. */
export const RV_BAKE_ROLE_KEY = 'BakeRole';

/**
 * Bake role of a node (plan-753 §2.3):
 *   1. an authored `rv.BakeRole` extras value wins,
 *   2. otherwise the STRONGEST role across the node's REGISTERED components
 *      (`keep` > `chunk` > `merge`),
 *   3. `undefined` when the node carries no registered component — the bake
 *      then inherits the enclosing node's role (Phase 2).
 *
 * `skip(type, config)` lets a caller ignore one component instance — the
 * plan-460 `RibbonRoller { SpinMode: 'Texture' }` case, which is the one web
 * component that does not move. Allocation-free.
 */
export function bakeRoleOf(
  node: Object3D,
  skip?: (type: string, config: unknown) => boolean,
): BakeRole | undefined {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return undefined;
  const override = rv[RV_BAKE_ROLE_KEY];
  if (isBakeRole(override)) return override;
  let best: BakeRole | undefined;
  for (const key in rv) {
    const cfg = rv[key];
    if (!cfg) continue;
    const caps = capabilitiesMap.get(key);
    if (!caps) continue;
    if (skip && skip(key, cfg)) continue;
    if (caps.bake === 'keep') return 'keep';
    if (caps.bake === 'chunk') best = 'chunk';
    else if (best === undefined) best = 'merge';
  }
  return best;
}

// ─── Component Factory Registration ─────────────────────────────

/** Factory descriptor for auto-discovered components */
export interface ComponentFactory {
  /** GLB extras key that triggers this component (e.g. 'Source', 'Sensor') */
  readonly type: string;
  /** Optional short label for hierarchy badges / inspector — falls back to `type` when omitted.
   *  Use this when the GLB key (e.g. 'WebSafetyDoor') differs from the user-facing name (e.g. 'SafetyDoor'). */
  readonly displayName?: string;
  /** Component schema for auto-mapping GLB extras → instance properties */
  readonly schema: ComponentSchema;
  /** Whether this component needs an AABB from BoxCollider extras */
  readonly needsAABB?: boolean;
  /** Optional capabilities for this component type (legacy shape accepted, warns once) */
  readonly capabilities?: ComponentCapabilities;
  /** Create the component instance */
  create(node: Object3D, aabb: AABB | null): RVComponent;
  /** Optional hook called BEFORE applySchema (e.g. extract raw data before coord conversion) */
  beforeSchema?(instance: RVComponent, extras: Record<string, unknown>): void;
  /** Optional hook called AFTER construction + applySchema (e.g. set node metadata) */
  afterCreate?(instance: RVComponent, node: Object3D): void;
}

/** Registered component factories for auto-discovery by the scene loader */
const registeredFactories = new Map<string, ComponentFactory>();

/**
 * Attach an RVComponent instance to a Three.js node's userData as
 * `_rvComponentInstance`. The property is NON-ENUMERABLE so Three.js's
 * `Object3D.clone()` (which does `JSON.parse(JSON.stringify(userData))` on
 * userData) doesn't try to serialize the circular instance↔node reference.
 * Direct access `node.userData._rvComponentInstance` still works.
 *
 * Re-assignable (writable/configurable) so re-running the scene loader for
 * the same node (e.g. hot-reload) doesn't throw on re-definition.
 */
export function setComponentInstance(node: Object3D, instance: object): void {
  const list = _instanceList(node, true)!;
  if (!list.includes(instance)) list.push(instance);
  if (node.userData._rvComponentInstance) return; // first-writer wins
  Object.defineProperty(node.userData, '_rvComponentInstance', {
    value: instance,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

/**
 * The ORDERED list of component instances attached to a node (plan-417 §2.4).
 *
 * A Unity node legitimately carries several rv_extras components — the demo
 * scene buttons put `SceneButtonMoveable` AND `SceneButtonBase` on the same
 * node. `_rvComponentInstance` can only ever hold one of them ("first-writer
 * wins", kept for every existing single-instance consumer), so the full set
 * lives alongside it in a non-enumerable `_rvComponentInstances` array in
 * registration order. Falls back to the single instance for nodes that were
 * stamped directly (components that define `_rvComponentInstance` themselves),
 * and to an empty array for nodes without any component.
 */
export function getComponentInstances(node: Object3D): readonly object[] {
  const list = _instanceList(node, false);
  if (list && list.length > 0) return list;
  const single = node.userData?._rvComponentInstance as object | undefined;
  return single ? [single] : EMPTY_INSTANCES;
}

/**
 * Detach one instance from a node — the counterpart of
 * {@link setComponentInstance}, used by component `dispose()` and the runtime
 * node teardown. Removes it from the ordered list and, when it was also the
 * single `_rvComponentInstance`, promotes the next remaining instance (or
 * drops the property when none is left).
 */
export function removeComponentInstance(node: Object3D, instance: object): void {
  const list = _instanceList(node, false);
  if (list) {
    const i = list.indexOf(instance);
    if (i >= 0) list.splice(i, 1);
  }
  if (node.userData?._rvComponentInstance !== instance) return;
  const next = list && list.length > 0 ? list[0] : undefined;
  if (next) node.userData._rvComponentInstance = next;
  else delete node.userData._rvComponentInstance;
}

const EMPTY_INSTANCES: readonly object[] = Object.freeze([]);

/** The node's instance array; created (non-enumerable) on demand. */
function _instanceList(node: Object3D, create: boolean): object[] | undefined {
  const existing = node.userData?._rvComponentInstances as object[] | undefined;
  if (existing || !create) return existing;
  const list: object[] = [];
  // Non-enumerable for the same reason as `_rvComponentInstance`: Three.js
  // clones userData through a JSON round-trip and would choke on the circular
  // instance ↔ node reference.
  Object.defineProperty(node.userData, '_rvComponentInstances', {
    value: list,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return list;
}

/**
 * Register a component factory for auto-discovery.
 * Components call this at module-load time. The scene loader iterates all
 * registered factories instead of using hardcoded if-blocks.
 * Also registers the schema for CONSUMED field derivation (backward compat).
 */
export function registerComponent(factory: ComponentFactory): void {
  // Wrap afterCreate so _rvComponentInstance is always set — enables
  // ComponentEventDispatcher parent-walk lookup regardless of whether the
  // factory defined its own afterCreate hook.
  const originalAfterCreate = factory.afterCreate;
  const wrappedFactory: ComponentFactory = {
    ...factory,
    afterCreate(instance: RVComponent, node: Object3D): void {
      if (originalAfterCreate) originalAfterCreate(instance, node);
      // Always via setComponentInstance: it keeps `_rvComponentInstance`
      // first-writer-wins AND appends to the ordered `_rvComponentInstances`
      // list the dispatcher walks (plan-417 §2.4). Both properties are
      // non-enumerable so JSON.stringify() skips the circular reference
      // (component → node → userData → component). Three.js Object3D.clone()
      // clones userData per JSON round-trip and would otherwise crash here
      // with "Converting circular structure to JSON" — seen since conditional
      // geometry clone (plan-153) reshapes spawn paths such that some sources
      // fall back to Object3D.clone() instead of instancing.
      setComponentInstance(node, instance);
    },
  };
  registeredFactories.set(factory.type, wrappedFactory);
  registeredSchemas.set(factory.type, factory.schema);
  _signalSlotFieldsCache.delete(factory.type);
  _schemaRegistrationEpoch++;
  if (factory.capabilities) {
    registerCapabilities(factory.type, factory.capabilities);
  }
}

/** Get all registered component factories (used by scene loader) */
export function getRegisteredFactories(): ReadonlyMap<string, ComponentFactory> {
  return registeredFactories;
}

/** Resolve a component type to its user-facing display label.
 *  Returns the factory's `displayName` if defined, otherwise the raw type. */
export function getDisplayName(type: string): string {
  return registeredFactories.get(type)?.displayName ?? type;
}

// ─── Schema-Derived CONSUMED Fields ─────────────────────────────

/** Registered component schemas for auto-derivation of CONSUMED fields */
const registeredSchemas = new Map<string, ComponentSchema>();

/**
 * Monotonic counter, bumped on EVERY schema registration (via
 * `registerComponent` or `registerComponentSchema`).
 *
 * Registration happens as a module-load side effect, so any consumer that
 * derives a set from `getRegisteredSchemaTypes()` cannot freeze its result at
 * module-load time — it would capture whatever happened to be imported first.
 * Comparing this epoch lets such a consumer cache its derivation and recompute
 * exactly once after a late registration (see `bindingSlotRvKeys()` in
 * rv-binding-slot-resolver.ts).
 */
let _schemaRegistrationEpoch = 0;

/** Current schema-registration epoch — a cache token, not an identity. */
export function getSchemaRegistrationEpoch(): number {
  return _schemaRegistrationEpoch;
}

/** Register a component schema for CONSUMED field auto-derivation, with optional capabilities. */
export function registerComponentSchema(componentType: string, schema: ComponentSchema, capabilities?: ComponentCapabilities): void {
  registeredSchemas.set(componentType, schema);
  _signalSlotFieldsCache.delete(componentType);
  _schemaRegistrationEpoch++;
  if (capabilities) {
    registerCapabilities(componentType, capabilities);
  }
}

/**
 * Derive CONSUMED field names from a registered component schema.
 * Returns all schema keys + their aliases.
 * Used by rv-extras-validator.ts to auto-populate CONSUMED lists.
 */
export function getConsumedFieldsFromSchema(componentType: string): string[] {
  const schema = registeredSchemas.get(componentType);
  if (!schema) return [];

  const fields: string[] = [];
  for (const [key, desc] of Object.entries(schema)) {
    // scope:'none' fields are not part of the inspector at all — never reported
    // as consumed, so they get no editable row and no overlay path.
    if (desc.scope === 'none') continue;
    fields.push(key);
    if (desc.aliases) {
      fields.push(...desc.aliases);
    }
  }
  return fields;
}

/**
 * The registered runtime schema of a type (from `registerComponent` or
 * `registerComponentSchema`), or undefined. Read-only view — used to describe
 * types that have no rv-ODT `$def` (inline schemas such as NodeKnowledge).
 */
export function getRegisteredSchema(componentType: string): Readonly<ComponentSchema> | undefined {
  return registeredSchemas.get(componentType);
}

/**
 * Get all registered schema types.
 * Used by rv-extras-validator.ts to know which types have schemas.
 */
export function getRegisteredSchemaTypes(): string[] {
  return [...registeredSchemas.keys()];
}

// ─── Signal-Slot Field Introspection (plan-325) ─────────────────

/** One `componentRef + signal` schema field — a bindable standard-signal SLOT. */
export interface SignalSlotField {
  /** Schema field name (= slot name, e.g. 'Forward'). */
  field: string;
  /** Declared PLC signal type (e.g. 'PLCOutputBool'). */
  signal: PlcSignalType;
  /** PLC direction derived from the signal type. */
  direction: 'plcInput' | 'plcOutput';
}

/** Cached per-type field lists — schemas are static after registration; the
 *  cache is invalidated whenever a schema is (re-)registered. */
const _signalSlotFieldsCache = new Map<string, readonly SignalSlotField[]>();
const EMPTY_SIGNAL_SLOT_FIELDS: readonly SignalSlotField[] = Object.freeze([]);

/**
 * All `componentRef + signal` fields of a registered schema type — the
 * component's bindable signal-slot universe, INDEPENDENT of whether a loaded
 * GLB carries a value for them (plan-325 F1: empty slots are still slots).
 * Returns a frozen empty array for unknown types. Results are cached per type.
 */
export function getSignalSlotFields(componentType: string): readonly SignalSlotField[] {
  const cached = _signalSlotFieldsCache.get(componentType);
  if (cached) return cached;
  const schema = registeredSchemas.get(componentType);
  if (!schema) return EMPTY_SIGNAL_SLOT_FIELDS;
  const fields: SignalSlotField[] = [];
  for (const [field, desc] of Object.entries(schema)) {
    if (desc.type === 'componentRef' && desc.signal) {
      fields.push({
        field,
        signal: desc.signal,
        direction: desc.signal.startsWith('PLCOutput') ? 'plcOutput' : 'plcInput',
      });
    }
  }
  const frozen = Object.freeze(fields);
  _signalSlotFieldsCache.set(componentType, frozen);
  return frozen;
}

/**
 * True when `(componentType, fieldName)` names a signal-slot field (directly or
 * via alias). The Property Inspector uses this as the rendering-precedence
 * gate: signal-slot keys are removed from the generic FieldRow pipeline and
 * rendered exclusively as SignalSlotRow rows (plan-325 S3/S4).
 */
export function isSignalSlotField(componentType: string, fieldName: string): boolean {
  const desc = getFieldDescriptor(componentType, fieldName);
  return desc?.type === 'componentRef' && !!desc.signal;
}

/**
 * Look up the FieldDescriptor for a single `(componentType, fieldName)` pair
 * from the registered schemas. Resolves aliases (a descriptor whose `aliases`
 * include the requested field name matches). Returns undefined when the type
 * has no schema or the field is not declared. Read-only metadata lookup — used
 * by the inspector (readonly gate) and the overlay/live-edit write guards.
 */
export function getFieldDescriptor(componentType: string, fieldName: string): FieldDescriptor | undefined {
  const schema = registeredSchemas.get(componentType);
  if (!schema) return undefined;
  const direct = schema[fieldName];
  if (direct) return direct;
  for (const desc of Object.values(schema)) {
    if (desc.aliases?.includes(fieldName)) return desc;
  }
  return undefined;
}

/**
 * Return `{ field: default }` for every schema field that declares a `default`.
 * Used to seed synthesized components (e.g. naming-convention drives) so they
 * carry the full editable field set — otherwise a drive derived from a
 * `Drive-Lin-Z` node would only expose `Direction` in the inspector, unlike an
 * authored Drive component which serializes every field.
 */
export function getSchemaDefaults(componentType: string): Record<string, unknown> {
  const schema = registeredSchemas.get(componentType);
  if (!schema) return {};
  const out: Record<string, unknown> = {};
  for (const [key, desc] of Object.entries(schema)) {
    // scope:'none' fields are never stamped — they have no inspector presence,
    // so seeding a default would create an orphan row with no overlay path.
    if (desc.scope === 'none') continue;
    if (desc.default !== undefined) {
      // json defaults are arrays/objects — deep-copy so the stamped extras
      // never share a mutable reference with the schema (or other nodes).
      out[key] = desc.type === 'json' ? structuredClone(desc.default) : desc.default;
    }
  }
  return out;
}
