// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import type { Object3D } from 'three';
import { NodeRegistry } from '../engine/rv-node-registry';
import { getConsumedFieldsFromSchema, getFieldDescriptor, isFieldDisplayReadonly } from '../engine/rv-component-registry';

export interface SdkSceneAccess {
  list(type?: string): { path: string; type: string }[];
  read(path: string, type: string): Record<string, unknown> | null;
  set(path: string, type: string, field: string, value: unknown): void;
}

/** Runtime-only, schema-limited access. Never exposes engine objects to the VM. */
export function createSceneScriptAccess(registry: NodeRegistry, root: Object3D): SdkSceneAccess {
  const instanceAt = (path: string, type: string) =>
    registry.getComponentsAt(path).find(([t]) => t === type)?.[1] as Record<string, unknown> | undefined;
  const valueCopy = (value: unknown): unknown => {
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value ?? null;
    if (typeof value === 'object' && ['x', 'y', 'z'].every(k => typeof (value as Record<string, unknown>)[k] === 'number')) {
      const v = value as { x: number; y: number; z: number };
      return { x: v.x, y: v.y, z: v.z };
    }
    return null;
  };
  return {
    list(type) {
      const result: { path: string; type: string }[] = [];
      root.traverse(node => {
        const path = NodeRegistry.computeNodePath(node);
        for (const t of registry.getComponentTypes(path)) {
          if (!type || t === type) result.push({ path, type: t });
        }
      });
      return result;
    },
    read(path, type) {
      const instance = instanceAt(path, type);
      if (!instance) return null;
      const values: Record<string, unknown> = {};
      for (const field of getConsumedFieldsFromSchema(type)) values[field] = valueCopy(instance[field]);
      if (typeof instance.getLiveState === 'function') {
        for (const [key, value] of Object.entries(instance.getLiveState())) values[key] = valueCopy(value);
      }
      return values;
    },
    set(path, type, field, value) {
      const instance = instanceAt(path, type);
      const desc = getFieldDescriptor(type, field);
      if (!instance || !desc || isFieldDisplayReadonly(desc) || desc.scope === 'none') {
        throw new Error(`Component field is unavailable or read-only: ${path}/${type}.${field}`);
      }
      if (instance.liveControlled === true) throw new Error('Component is controlled by a live connection');
      if (!['number', 'boolean', 'string', 'enum', 'vector3'].includes(desc.type)) {
        throw new Error('Use signal handles for signals; component references require scene editing');
      }
      if (desc.type === 'enum') {
        if (!desc.enumMap || !Object.values(desc.enumMap).includes(value)) throw new Error('Invalid enum value');
      } else if (desc.type === 'vector3') {
        const v = value as { x?: unknown; y?: unknown; z?: unknown } | null;
        if (!v || ![v.x, v.y, v.z].every(n => typeof n === 'number' && Number.isFinite(n))) throw new Error('Expected a finite vector');
        const target = instance[field] as { x: number; y: number; z: number };
        Object.assign(target, { x: v.x, y: v.y, z: v.z });
        if (typeof instance.reapplyConfig === 'function') instance.reapplyConfig();
        return;
      } else if (typeof value !== desc.type || (typeof value === 'number' && !Number.isFinite(value))) {
        throw new Error(`Expected ${desc.type}`);
      }
      instance[field] = value;
      if (typeof instance.reapplyConfig === 'function') instance.reapplyConfig();
    },
  };
}
