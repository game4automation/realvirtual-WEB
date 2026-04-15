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
import type { NodeRegistry, ComponentRef } from './rv-node-registry';
import type { SignalStore } from './rv-signal-store';
import type { RVTransportManager } from './rv-transport-manager';
import type { AABB } from './rv-aabb';

// ─── Schema Types ────────────────────────────────────────────────

export type FieldType = 'number' | 'boolean' | 'string' | 'vector3' | 'componentRef' | 'componentRefArray' | 'enum';

export interface FieldDescriptor {
  type: FieldType;
  default?: unknown;
  /** For 'enum': maps GLB string → internal value */
  enumMap?: Record<string, unknown>;
  /** For 'vector3': apply Unity→glTF coordinate transform (negate X) */
  unityCoords?: boolean;
  /** Alternative GLB field names (legacy compat) */
  aliases?: string[];
}

export type ComponentSchema = Record<string, FieldDescriptor>;

/** Context passed to component init() — component decides how to use it */
export interface ComponentContext {
  registry: NodeRegistry;
  signalStore: SignalStore;
  scene: Scene;
  transportManager: RVTransportManager;
  /** Root of the loaded GLB scene (needed by Source for spawnParent) */
  root: Object3D;
}

/** Interface all auto-mapped components implement */
export interface RVComponent {
  readonly node: Object3D;
  /** True when this component owns its simulation (local authority).
   *  Set to false by MultiuserPlugin when server is authority. Default: true. */
  isOwner: boolean;
  init(context: ComponentContext): void;
  dispose?(): void;
  /** Called when ownership changes (e.g. multiuser connect/disconnect).
   *  Components self-manage their multiuser behavior in this callback. */
  onOwnershipChanged?(isOwner: boolean): void;
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
 * Unresolvable refs → null (does not throw)
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
  /** Component receives onFixedUpdate calls. Default: false */
  simulationActive?: boolean;
  /** Hover is enabled by default after scene load. Default: same as hoverable */
  hoverEnabledByDefault?: boolean;
  /** Part of exclusive hover mode (Drive/Sensor/MU toggle). Default: false */
  exclusiveHoverGroup?: boolean;
  /** Hover tooltip priority (higher = rendered first in bubble). Default: 5 */
  hoverPriority?: number;
  /** Pin tooltip priority. Default: 3 */
  pinPriority?: number;
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
  simulationActive: false,
  hoverEnabledByDefault: false,
  exclusiveHoverGroup: false,
  hoverPriority: 5,
  pinPriority: 3,
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
 * Register a component factory for auto-discovery.
 * Components call this at module-load time. The scene loader iterates all
 * registered factories instead of using hardcoded if-blocks.
 * Also registers the schema for CONSUMED field derivation (backward compat).
 */
export function registerComponent(factory: ComponentFactory): void {
  registeredFactories.set(factory.type, factory);
  registeredSchemas.set(factory.type, factory.schema);
  if (factory.capabilities) {
    registerCapabilities(factory.type, factory.capabilities);
  }
}

/** Get all registered component factories (used by scene loader) */
export function getRegisteredFactories(): ReadonlyMap<string, ComponentFactory> {
  return registeredFactories;
}

// ─── Schema-Derived CONSUMED Fields ─────────────────────────────

/** Registered component schemas for auto-derivation of CONSUMED fields */
const registeredSchemas = new Map<string, ComponentSchema>();

/** Register a component schema for CONSUMED field auto-derivation, with optional capabilities. */
export function registerComponentSchema(componentType: string, schema: ComponentSchema, capabilities?: ComponentCapabilities): void {
  registeredSchemas.set(componentType, schema);
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
