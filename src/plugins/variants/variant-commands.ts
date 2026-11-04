// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { runLeaseBlocker } from '../../core/hmi/rv-run-lease';
import type { RVViewer } from '../../core/rv-viewer';
import type { CommandContext, CommandEnabled, CommandImpl } from '../../core/hmi/rv-command-registry';
import { viewerParamFieldEnv } from '../../core/params/rv-param-apply';
import type { FieldKey, ParamValue } from '../../core/params/rv-param-field';
import { diffRows, type VariantDiffRow, type VariantsBlock } from '../../core/variants/rv-variant-model';
import type { VariantResult } from '../../core/variants/rv-variant-store';
import type { VariantsRuntime } from './variants-runtime';
import { resolveScenarioTarget } from '../planning-parameters/scenario-persistence';

interface VariantPluginApi {
  readonly enabled: boolean;
  readonly runtimeLoaded: boolean;
  readonly documentHasVariants: boolean;
  setEnabled(on: boolean): Promise<void>;
  runtime(): Promise<VariantsRuntime>;
  commandRuntime(): Promise<VariantsRuntime>;
}

export interface VariantDiffOutputRow {
  address: string;
  path: string;
  component: string;
  field: string;
  unit: string | null;
  base: ParamValue | null;
  values: Record<string, ParamValue | null>;
  missingIn: string[];
}

type SetArgs = { id: string; address?: string; path?: string; component: string; field: string; value: ParamValue | null };
export type CreateVariantResult =
  | { ok: true; id?: string }
  | { ok: false; error: string; detail?: string; id?: string };

function pluginOf(viewer: RVViewer): VariantPluginApi | null {
  return (viewer.getPlugin?.('variants') as VariantPluginApi | undefined) ?? null;
}

function enabled({ viewer }: CommandContext): CommandEnabled {
  return pluginOf(viewer) ? true : { reason: 'variants are unavailable' };
}

async function runtimeOf(viewer: RVViewer): Promise<VariantsRuntime> {
  const plugin = pluginOf(viewer);
  if (!plugin) throw new Error('variants are unavailable');
  return plugin.commandRuntime();
}

function baseValue(rt: VariantsRuntime, key: FieldKey) {
  return rt.store.baseOf(key) ?? rt.service.readBase(key);
}

function rowOutput(viewer: RVViewer, rt: VariantsRuntime, row: VariantDiffRow, ids: readonly string[]): VariantDiffOutputRow {
  const node = rt.service.resolve(row);
  const path = node ? viewer.registry?.getPathForNode(node) : null;
  const values: Record<string, ParamValue | null> = {};
  for (const id of ids) values[id] = row.values[id] ?? null;
  return {
    address: row.address, path: path ?? row.address, component: row.component, field: row.field,
    unit: viewerParamFieldEnv.fieldInfo(row.component, row.field)?.unit ?? null,
    base: row.base?.kind === 'value' ? row.base.value : null,
    values,
    missingIn: rt.store.isUnresolved(row) && rt.store.sceneVariant && ids.includes(rt.store.sceneVariant)
      ? [rt.store.sceneVariant] : [],
  };
}

function selectedBlock(block: VariantsBlock, ids?: readonly string[]): VariantsBlock {
  if (!ids) return block;
  const wanted = new Set(ids);
  return { ...block, variants: block.variants.filter((v) => wanted.has(v.id)) };
}

/** Read the current variant catalogue. The preference-off fast path does not load the runtime. */
export async function listVariants(viewer: RVViewer) {
  const plugin = pluginOf(viewer);
  const persistable = resolveScenarioTarget().persistable;
  if (!plugin || (!plugin.enabled && !plugin.runtimeLoaded && !plugin.documentHasVariants)) {
    return { enabled: false, active: null, persistable, dirty: false, variants: [] };
  }
  const rt = await runtimeOf(viewer);
  return {
    enabled: plugin.enabled, active: rt.store.sceneVariant, persistable, dirty: rt.store.dirty,
    variants: rt.store.block.variants.map(({ id, name, revision, overrides }) => ({ id, name, revision, overrideCount: overrides.length })),
  };
}

export async function diffVariants(viewer: RVViewer, args: { variants?: string[] } = {}) {
  const plugin = pluginOf(viewer);
  if (!plugin || (!plugin.enabled && !plugin.runtimeLoaded && !plugin.documentHasVariants)) return { rows: [] };
  const rt = await runtimeOf(viewer);
  const block = selectedBlock(rt.store.block, args.variants);
  const ids = block.variants.map((v) => v.id);
  return { rows: diffRows(block, (key) => baseValue(rt, key)).map((row) => rowOutput(viewer, rt, row, ids)) };
}

export async function createVariant(viewer: RVViewer, { name }: { name: string }): Promise<CreateVariantResult> {
  const plugin = pluginOf(viewer);
  if (!plugin) return { ok: false, error: 'variants-unavailable' };
  await plugin.setEnabled(true);
  const rt = await plugin.runtime();
  const made = rt.create(name);
  if (!made.ok || !made.id) return made;
  const shown = await rt.activate(made.id);
  return { ...shown, id: made.id };
}

export async function activateVariant(viewer: RVViewer, { id }: { id: string }): Promise<VariantResult> {
  return (await runtimeOf(viewer)).activate(id === 'base' ? null : id);
}

function addressFrom(viewer: RVViewer, args: { address?: string; path?: string }): string | null {
  if (typeof args.address === 'string' && args.address.trim()) return args.address.trim();
  if (typeof args.path !== 'string' || !args.path.trim()) return null;
  const registry = viewer.registry;
  const hit = registry?.findNodeForUser(args.path);
  return hit ? registry?.getAddressForNode(hit.node) ?? null : null;
}

export async function setVariant(viewer: RVViewer, args: SetArgs): Promise<VariantDiffOutputRow | { ok: false; reason: string; detail?: string }> {
  const address = addressFrom(viewer, args);
  if (!address) return { ok: false, reason: args.path ? 'path-not-found' : 'address-or-path-required' };
  const rt = await runtimeOf(viewer);
  const key = { address, component: args.component, field: args.field };
  let value = args.value;
  const type = viewerParamFieldEnv.fieldInfo(args.component, args.field)?.type;
  if (typeof value === 'string' && /^(number|integer|float|int)$/i.test(type ?? '')) {
    const parsed = value.trim() ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) return { ok: false, reason: `${args.component}.${args.field} needs a finite number` };
    value = parsed;
  }
  // `value` is a string in the schema (an MCP caller cannot send a typed union), so a boolean
  // field takes "true"/"false" the same way a numeric field takes a numeric string.
  if (typeof value === 'string' && /^bool(ean)?$/i.test(type ?? '')) {
    const s = value.trim().toLowerCase();
    if (s !== 'true' && s !== 'false') return { ok: false, reason: `${args.component}.${args.field} needs a boolean ("true" or "false")` };
    value = s === 'true';
  }
  const result = value === null ? await rt.store.unset(args.id, key) : await rt.store.set(args.id, key, value);
  if (!result.ok) return { ok: false, reason: result.error, ...(result.detail ? { detail: result.detail } : {}) };
  const rows = (await diffVariants(viewer)).rows;
  const existing = rows.find((row) => row.address === address && row.component === args.component && row.field === args.field);
  if (existing) return existing;
  return rowOutput(viewer, rt, { ...key, base: baseValue(rt, key), values: {} }, rt.store.block.variants.map((v) => v.id));
}

export async function renameVariant(viewer: RVViewer, args: { id: string; name: string }): Promise<VariantResult> {
  return (await runtimeOf(viewer)).store.rename(args.id, args.name);
}

export async function duplicateVariant(viewer: RVViewer, args: { id: string; name: string }): Promise<VariantResult> {
  return (await runtimeOf(viewer)).store.duplicate(args.id, args.name);
}

export async function deleteVariant(viewer: RVViewer, { id }: { id: string }): Promise<VariantResult> {
  return (await runtimeOf(viewer)).store.remove(id);
}

export async function saveVariants(viewer: RVViewer) {
  return (await runtimeOf(viewer)).save();
}

export const variantList: CommandImpl = { enabled, run: ({ viewer }) => listVariants(viewer) };
export const variantDiff: CommandImpl<{ variants?: string[] }> = { enabled, run: ({ viewer }, args) => diffVariants(viewer, args) };
const mutationEnabled = (ctx: CommandContext): CommandEnabled => runLeaseBlocker() ?? enabled(ctx);

export const variantCreate: CommandImpl<{ name: string }> = { enabled: mutationEnabled, run: ({ viewer }, args) => createVariant(viewer, args) };
export const variantActivate: CommandImpl<{ id: string }> = { enabled: mutationEnabled, run: ({ viewer }, args) => activateVariant(viewer, args) };
export const variantSet: CommandImpl<SetArgs> = { enabled: mutationEnabled, run: ({ viewer }, args) => setVariant(viewer, args) };
export const variantRename: CommandImpl<{ id: string; name: string }> = { enabled: mutationEnabled, run: ({ viewer }, args) => renameVariant(viewer, args) };
export const variantDuplicate: CommandImpl<{ id: string; name: string }> = { enabled: mutationEnabled, run: ({ viewer }, args) => duplicateVariant(viewer, args) };
export const variantDelete: CommandImpl<{ id: string }> = { enabled: mutationEnabled, run: ({ viewer }, args) => deleteVariant(viewer, args) };
export const variantSave: CommandImpl = { enabled: mutationEnabled, run: ({ viewer }) => saveVariants(viewer) };
