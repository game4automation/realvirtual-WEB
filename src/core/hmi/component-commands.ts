// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, type CommandImpl, type CommandRegistry } from './rv-command-registry';
import { ensureEditorCommandsRegistered } from './editor-command-descriptors';
import { getActiveAssetContext } from '../editor/active-asset-store';
import { getFieldDescriptor, isFieldDisplayReadonly } from '../engine/rv-component-registry';
import { isComponentReference } from '../engine/rv-node-path-rewrite.mjs';
import { ERR_EDITOR_ACTIVATING, ERR_DOCUMENT_CHANGED } from '../editor/rv-editor-guard-core';
import type { RvExtrasEditorPlugin } from './rv-extras-editor';
import { getActiveEditTarget, getActivePersistenceTarget } from './rv-edit-target';

interface SetFieldsArgs { path: string; type: string; props: string }

/** The inspector's field metadata, including instance fields and signal slots. */
function fieldRejection(type: string, field: string, value: unknown, data: Record<string, unknown>): string | null {
  // Same numbered-instance spelling as the inspector, without importing its UI helpers.
  const d = getFieldDescriptor(type.replace(/_\d+$/, ''), field, data);
  if (!d) return `Unknown field "${field}" on ${type}`;
  if (isFieldDisplayReadonly(d)) return `Field "${field}" is read-only`;
  switch (d.type) {
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'Expected a finite number';
      if (d.min !== undefined && value < d.min) return `Minimum is ${d.min}`;
      if (d.max !== undefined && value > d.max) return `Maximum is ${d.max}`;
      break;
    case 'boolean': case 'string':
      if (typeof value !== d.type) return `Expected ${d.type}`;
      break;
    case 'enum':
      if (!d.enumMap || !Object.prototype.hasOwnProperty.call(d.enumMap, String(value))) return 'Expected a schema enum value';
      break;
    case 'componentRef':
      if (value !== null && !isComponentReference(value)) return 'Expected a ComponentReference object or null';
      break;
    case 'componentRefArray':
      if (!Array.isArray(value) || !value.every(isComponentReference)) return 'Expected an array of ComponentReference objects';
      break;
    case 'vector3': {
      const v = value as Record<string, unknown> | null;
      if (!v || !['x', 'y', 'z'].every(k => typeof v[k] === 'number' && Number.isFinite(v[k]))) return 'Expected a Vector3 object with finite x, y, z';
      break;
    }
  }
  return null;
}

export const componentSetFields: CommandImpl<SetFieldsArgs> = {
  enabled: ({ viewer }) => {
    if (!viewer) return { reason: 'No viewer' };
    if (viewer.modes?.activeMode === 'editor' && getActiveAssetContext()?.viewer !== viewer) {
      return { reason: ERR_EDITOR_ACTIVATING };
    }
    return true;
  },
  resolveArgs: (_ctx, a) => ({ path: a.path, type: a.type, props: a.props }),
  run: async (ctx, { path, type, props }) => {
    let parsed: unknown;
    try { parsed = JSON.parse(props); }
    catch { return { error: 'props must be a JSON object string, e.g. {"TargetSpeed": 500}' }; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: 'props must be a JSON object' };
    const active = getActiveAssetContext();
    const doc = ctx.viewer.modes?.activeMode === 'editor' && active?.viewer === ctx.viewer ? active.doc : null;
    const overlay = ctx.viewer.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
    const data = ctx.viewer.registry?.getNode(path)?.userData?.realvirtual?.[type] as Record<string, unknown> | undefined;
    const applied: Record<string, unknown> = {};
    const rejected: { field: string; reason: string }[] = [];
    const valid: [string, unknown][] = [];
    for (const [field, value] of Object.entries(parsed)) {
      const reason = data ? fieldRejection(type, field, value, data) : `No component "${type}" on ${path}`;
      if (reason) rejected.push({ field, reason }); else valid.push([field, value]);
    }
    if (!doc && getActivePersistenceTarget() === 'variant') {
      const target = getActiveEditTarget();
      const refusal = rejected[0];
      if (refusal) return { ok: false, reason: refusal.reason };
      if (!target.setFieldAsync) return { ok: false, reason: 'Active variant target cannot confirm field writes' };
      for (const [field, value] of valid) {
        const verdict = target.trySetField?.(path, type, field, value);
        if (verdict && !verdict.ok) return { ok: false, reason: verdict.reason };
      }
      try {
        await target.withTransaction('Set fields', async () => {
          for (const [field, value] of valid) {
            await target.setFieldAsync!(path, type, field, value, data?.[field]);
            applied[field] = value;
          }
        });
      } catch (reason) {
        return { ok: false, reason: reason instanceof Error ? reason.message : String(reason) };
      }
      return { path, type, applied, rejected };
    }
    if (!doc && !overlay) return { error: 'Extras editor not available' };
    if (doc && valid.length) {
      ensureEditorCommandsRegistered();
      // Call the implementation directly: one outer command/macro line, while retaining
      // setField's authoring guard, awaited document write and reference-aware read-back.
      const impl = await commandRegistry.get('editor.setField')!.impl() as CommandImpl | null;
      if (!impl) return { error: 'Editor not available' };
      if (getActiveAssetContext() !== active || ctx.viewer.modes?.activeMode !== 'editor') {
        return { error: ERR_DOCUMENT_CHANGED };
      }
      const editorCtx = { ...ctx, doc };
      await doc.withTransaction('Set fields', async () => {
        for (const [field, value] of valid) {
          const args = { path, componentType: type, fieldName: field, valueJson: JSON.stringify(value) };
          const enabled = impl.enabled(editorCtx, args);
          if (enabled !== true) { rejected.push({ field, reason: enabled.reason }); continue; }
          await impl.run(editorCtx, args);
          applied[field] = value;
        }
      });
      await doc.whenIdle();
    } else if (!doc) {
      for (const [field, value] of valid) {
        if (overlay!.updateOverlayField(path, type, field, value)) applied[field] = value;
        else rejected.push({ field, reason: 'Inspector overlay refused the field write' });
      }
    }
    return { path, type, applied, rejected };
  },
};

const registered = new WeakSet<CommandRegistry>();
export function ensureComponentCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.register({
    id: 'component.setFields', label: 'Set fields', undoLabel: 'Set fields',
    readOnly: false, macro: true, scope: 'none', available: true, unavailableReason: 'Not available',
    argsSchema: { path: 'string', type: 'string', props: 'string' },
    eagerImpl: componentSetFields, impl: () => Promise.resolve(componentSetFields),
  });
}
