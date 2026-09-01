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
import type { Object3D, Scene } from 'three';
import rvOdt from '../../../schema/v1/rv-odt.json';
import type { NodeRegistry, ComponentRef } from './rv-node-registry';
import type { SignalStore } from './rv-signal-store';
import type { RVTransportManager } from './rv-transport-manager';
import type { AABB } from './rv-aabb';
import type { GizmoOverlayManager } from './rv-gizmo-manager';
import type { LampManager } from './rv-lamp-manager';
import type { SceneButtonManager } from './rv-scene-button-manager';
import type { EnergyChainManager } from './rv-energy-chain-manager';
import type { ChainManager } from './rv-chain-manager';
import type { MachiningManager } from './rv-machining-manager';
import type { CollisionRoleRegistrar } from './rv-collision-role';
import type { KinematicManagerLike } from './rv-kinematic-registry';
import type { SignalReapplyRegistry } from './rv-signal-reapply-registry';
import type { RVOutlineManager } from './rv-outline-manager';
import type { ErrorStore } from './rv-error-store';
import type { InstructionRuntimeStore } from './rv-instruction-runtime-store';
import type { ComponentEventDispatcher } from './rv-component-event-dispatcher';
import type { ObjectHoverData } from './rv-raycast-manager';
import type { EventEmitter } from '../rv-events';
import type { ViewerEvents } from '../rv-viewer-events';

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
interface OdtProperty {
  type?: string;
  $ref?: string;
  items?: { $ref?: string };
  enum?: string[];
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
}

interface OdtComponentDef {
  properties?: Record<string, OdtProperty>;
  /** Custom keyword: primary field name → array of legacy GLB field names. */
  aliases?: Record<string, string[]>;
}

const ODT_DEFS = (rvOdt as unknown as { $defs: Record<string, OdtComponentDef> }).$defs;

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
    if (p.scope === 'live' || p.scope === 'des' || p.scope === 'none') desc.scope = p.scope;

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
): void {
  for (const key of Object.keys(instance)) {
    const val = instance[key];

    // Handle arrays of ComponentRefs (componentRefArray schema type)
    if (Array.isArray(val)) {
      const resolved: unknown[] = [];
      let isRefArray = false;
      for (const item of val) {
        if (isComponentRef(item)) {
          isRefArray = true;
          const ref = item as ComponentRef;
          const res = registry.resolve(ref);
          if (res.signalAddress !== undefined) {
            resolved.push(res.signalAddress);
          } else if (res.sensor !== undefined) {
            resolved.push(res.sensor);
          } else if (res.drive !== undefined) {
            resolved.push(res.drive);
          } else if (res.node !== undefined) {
            resolved.push(res.node);
          } else if (res.component !== undefined) {
            // Generic registered component (plan-411 §2.2) — same treatment as
            // a Drive/Sensor element, so an array of mechanism/tool references
            // arrives as instances rather than as strings the consumer has to
            // resolve a second time.
            resolved.push(res.component);
          } else {
            // Keep the raw ref path for DES component resolution
            resolved.push(ref.path);
          }
        } else {
          resolved.push(item);
        }
      }
      if (isRefArray) {
        instance[key] = resolved;
      }
      continue;
    }

    if (!isComponentRef(val)) continue;

    const ref = val as ComponentRef;
    const resolved = registry.resolve(ref);

    if (resolved.signalAddress !== undefined) {
      instance[key] = resolved.signalAddress;
    } else if (resolved.sensor !== undefined) {
      instance[key] = resolved.sensor;
    } else if (resolved.drive !== undefined) {
      instance[key] = resolved.drive;
    } else if (resolved.node !== undefined) {
      // Generic node ref (Unity `Transform` field, plan-362). A resolved node
      // must NOT be flattened to null by the fallthrough below.
      instance[key] = resolved.node;
    } else if (resolved.component !== undefined) {
      // Generic registered component (plan-411 §2.2) — e.g. a
      // `realvirtual.KinematicMechanism` reference, which used to land in the
      // null fallthrough below and forced a per-component path workaround.
      instance[key] = resolved.component;
    } else {
      // Unresolvable — set to null rather than throwing
      instance[key] = null;
    }
  }
}

/** Check if a value looks like a raw ComponentRef from GLB extras */
function isComponentRef(val: unknown): boolean {
  if (val === null || val === undefined || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return obj['type'] === 'ComponentReference' && typeof obj['path'] === 'string';
}

// ─── Component Capabilities ─────────────────────────────────────

/** Capabilities that a component type can declare. */
export interface ComponentCapabilities {
  /** Component triggers hover/highlight on pointer move. Default: false */
  hoverable?: boolean;
  /** Component can be selected via click. Default: false */
  selectable?: boolean;
  /** Component appears in the Property Inspector. Default: true */
  inspectorVisible?: boolean;
  /** Component appears in Hierarchy Browser. Default: true */
  hierarchyVisible?: boolean;
  /** Tooltip content type on hover (must match tooltip-registry key). null = no tooltip. Default: null */
  tooltipType?: string | null;
  /** Badge color hex in hierarchy browser. Default: '#90a4ae' */
  badgeColor?: string;
  /** Label for search/filter dropdown. null = not filterable. Default: null */
  filterLabel?: string | null;
  /** Hover is enabled by default after scene load. Default: same as hoverable */
  hoverEnabledByDefault?: boolean;
  /** Part of exclusive hover mode (Drive/Sensor/MU toggle). Default: false */
  exclusiveHoverGroup?: boolean;
  /** Hover tooltip priority (higher = rendered first in bubble). Default: 5 */
  hoverPriority?: number;
  /** Pin tooltip priority. Default: 3 */
  pinPriority?: number;
  /** Component can be ADDED to nodes in the asset editor ("Add Component"
   *  inspector section). Requires a complete schema (initial field values
   *  come from `getSchemaDefaults`). Default: false */
  authorable?: boolean;
}

/** Conservative defaults — nothing enabled except visibility. */
export const DEFAULT_CAPABILITIES: Readonly<Required<ComponentCapabilities>> = Object.freeze({
  hoverable: false,
  selectable: false,
  inspectorVisible: true,
  hierarchyVisible: true,
  tooltipType: null,
  badgeColor: '#90a4ae',
  filterLabel: null,
  hoverEnabledByDefault: false,
  exclusiveHoverGroup: false,
  hoverPriority: 5,
  pinPriority: 3,
  authorable: false,
});

/** Separate Map for Capabilities (contains Factory-registered AND standalone entries). */
const capabilitiesMap = new Map<string, Readonly<Required<ComponentCapabilities>>>();

/** Register capabilities for a type (standalone, without factory). */
export function registerCapabilities(
  type: string,
  capabilities: ComponentCapabilities,
): void {
  if (import.meta.env.DEV && capabilitiesMap.has(type)) {
    console.warn(`[rv] Capabilities for '${type}' already registered — overwriting`);
  }
  const resolved = Object.freeze({ ...DEFAULT_CAPABILITIES, ...capabilities });
  capabilitiesMap.set(type, resolved);
}

/** Reset all capability registrations (test-only). */
export function _resetCapabilitiesForTesting(): void {
  capabilitiesMap.clear();
}

/** Get resolved capabilities for a type. Returns defaults for unknown types. */
export function getCapabilities(type: string): Readonly<Required<ComponentCapabilities>> {
  return capabilitiesMap.get(type) ?? DEFAULT_CAPABILITIES;
}

/** Get all types that have a specific boolean capability set to true. */
export function getTypesWithCapability(
  cap: keyof ComponentCapabilities,
): string[] {
  const result: string[] = [];
  for (const [type, caps] of capabilitiesMap) {
    if (caps[cap]) result.push(type);
  }
  return result;
}

/** Get all registered capabilities as a ReadonlyMap. */
export function getRegisteredCapabilities(): ReadonlyMap<string, Readonly<Required<ComponentCapabilities>>> {
  return capabilitiesMap;
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
  /** Optional capabilities for this component type */
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
