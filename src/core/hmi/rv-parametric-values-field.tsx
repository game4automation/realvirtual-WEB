// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-parametric-values-field.tsx — the parameter mask of a parametric family
 * (plan-650 §2.7 / §3.1).
 *
 * Replaces the raw `ParametricComponent.Values` row: one row per entry of
 * `Params`, described by the instance field resolver
 * (`getFieldDescriptor('ParametricComponent', 'Values.<Name>', data)` — unit,
 * min/max/step, enum choices). A number commits at the END of an edit (blur,
 * Enter, end of drag), an enum or bool at once — each commit is ONE
 * regeneration and one undo step (`regenerateParametric`, loaded on demand).
 * A failed regeneration keeps the old values (the row springs back) and the
 * message stays below the mask; a request while the simulation runs is shown
 * as deferred.
 *
 * Two writers, one mask: in the asset editor (a document open in it) a
 * commit runs `regenerateParametric`; on a layout placement (a `_layoutId`
 * record root above the family node) it runs the planner command
 * `layout.setParams` — the same command `web_execute` reaches, so the UI has
 * no write logic of its own (plan-650 Phase 5). Elsewhere the mask is
 * read-only.
 */

import { useCallback, useState, useSyncExternalStore } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { InspectorRow } from './rv-inspector-row';
import { BooleanEditor, EnumEditor, NumberEditor } from './rv-field-editors';
import { ERROR, FS, INK_LOW, INK_MID, WARN } from './shared-sx';
import { getFieldDescriptor } from '../engine/rv-component-registry';
import { commandRegistry } from './rv-command-registry';
import { getNodeId } from '../engine/rv-node-id';
import type { Object3D } from 'three';
import {
  PARAMETRIC_COMPONENT_TYPE,
  VALUES_FIELD_PREFIX,
  parseParametricComponent,
  type ParamValue,
} from '../engine/rv-parametric-component';
import { getActiveAssetContext, getActiveAssetVersion, subscribeActiveAsset } from '../editor/active-asset-store';

/** The planner's own lookup (duck-typed: core never imports the plugin). */
interface PlacedAncestorLookup {
  findPlacedAncestor?(node: Object3D): { id: string; root: Object3D } | null;
}

/**
 * The placement a family node belongs to + the family path relative to its
 * root, or null (not inside a placement). Asks the layout planner first
 * (`findPlacedAncestor`, the id `layout.setParams` accepts); without one it
 * falls back to the `_layoutId` record root.
 */
export function placementTargetOf(
  node: Object3D | null, planner?: PlacedAncestorLookup | null,
): { id: string; family: string } | null {
  if (!node) return null;
  const hit = planner?.findPlacedAncestor?.(node) ?? null;
  const names: string[] = [];
  for (let n: Object3D | null = node; n; n = n.parent) {
    if (hit ? n === hit.root : typeof n.userData?._layoutId === 'string') {
      return { id: hit ? hit.id : (n.userData._layoutId as string), family: names.join('/') };
    }
    names.unshift(n.name);
  }
  return null;
}

function plannerOf(viewer: FieldRendererProps['viewer']): PlacedAncestorLookup | null {
  const v = viewer as unknown as { getPlugin?: (id: string) => unknown } | null;
  return (v?.getPlugin?.('layout-planner') as PlacedAncestorLookup | undefined) ?? null;
}

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'info'; text: string } | { kind: 'error'; text: string };

function ParametricValuesField({ value, nodePath, viewer }: FieldRendererProps) {
  useSyncExternalStore(subscribeActiveAsset, getActiveAssetVersion);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const node = viewer?.registry?.getNode(nodePath) ?? null;
  const raw = (node?.userData?.realvirtual as Record<string, unknown> | undefined)?.[PARAMETRIC_COMPONENT_TYPE];
  const parsed = parseParametricComponent(raw);
  const ctx = getActiveAssetContext();
  const inAssetEditor = !!ctx && ctx.viewer === viewer;
  const placement = inAssetEditor ? null : placementTargetOf(node, plannerOf(viewer));
  const editable = (inAssetEditor || !!placement) && parsed.ok;
  const values = (value && typeof value === 'object' ? value : {}) as Record<string, ParamValue>;

  const commit = useCallback(async (patch: Record<string, unknown> | 'defaults') => {
    if (!parsed.ok) return;
    const next = patch === 'defaults'
      ? Object.fromEntries(parsed.value.Params.map((p) => [p.Name, p.Default]))
      : patch;
    const active = getActiveAssetContext();
    if (!active || active.viewer !== viewer) {
      const famNode = viewer?.registry?.getNode(nodePath) ?? null;
      const target = placementTargetOf(famNode, plannerOf(viewer));
      if (!target || !viewer) return;
      // The NodeId names the family unambiguously (a root family has relPath '').
      const family = (famNode && getNodeId(famNode)) || target.family || null;
      setStatus({ kind: 'busy' });
      const res = await commandRegistry.execute<{ status: string; generatorRuns: number; variantBakes: number }>(
        'layout.setParams',
        { id: target.id, values: JSON.stringify(next), family },
        { origin: 'ui', viewer },
      );
      if (!res.ok) setStatus({ kind: 'error', text: res.reason });
      else if (res.value.status === 'deferred') setStatus({ kind: 'info', text: 'Applied when the simulation stops' });
      else {
        const v = res.value;
        setStatus({
          kind: 'info',
          text: v.generatorRuns > 0 ? `Generated · ${v.variantBakes} variant bake${v.variantBakes === 1 ? '' : 's'}`
            : v.variantBakes > 0 ? 'Variant from cache' : 'Unchanged',
        });
      }
      return;
    }
    setStatus({ kind: 'busy' });
    const m = await import('../editor/rv-parametric-regenerate');
    const out = await m.regenerateParametric(active, nodePath, next);
    if (out.status === 'failed') setStatus({ kind: 'error', text: `${out.error.code}: ${out.error.message}` });
    else if (out.status === 'deferred') setStatus({ kind: 'info', text: 'Applied when the simulation stops' });
    else if (out.status === 'applied') {
      const s = out.stats;
      const warn = out.messages.find((msg) => msg.level === 'warning');
      setStatus({
        kind: 'info',
        text: warn ? warn.text
          : s ? `${s.instances} parts · ${s.vertices} vertices · ${s.elapsedMs} ms` : 'Variant from cache',
      });
    } else setStatus({ kind: 'idle' });
  }, [nodePath, parsed, viewer]);

  if (!parsed.ok) {
    return (
      <Box sx={{ px: 1, py: 0.5 }}>
        <Typography sx={{ fontSize: FS.label, color: ERROR }}>Invalid family: {parsed.errors.join('; ')}</Typography>
      </Box>
    );
  }
  const fam = parsed.value;
  const data = raw as Record<string, unknown>;

  return (
    <Box data-testid="rv-parametric-mask">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, pb: 0.5 }}>
        <Typography sx={{ fontSize: FS.label, color: INK_MID, fontFamily: 'monospace' }} title={`Code ${fam.CodeHash}`}>
          Code {fam.CodeHash ? `${fam.CodeHash.slice(0, 8)}…` : '—'}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {editable && fam.Params.length > 0 && (
          <Button size="small" onClick={() => { void commit('defaults'); }} disabled={status.kind === 'busy'}
            sx={{ minWidth: 0, height: 22, px: 0.75, fontSize: FS.label, textTransform: 'none' }}>
            Reset
          </Button>
        )}
      </Box>
      {fam.Params.map((p) => {
        const desc = getFieldDescriptor(PARAMETRIC_COMPONENT_TYPE, `${VALUES_FIELD_PREFIX}${p.Name}`, data);
        const current = values[p.Name] ?? p.Default;
        const disabled = !editable || status.kind === 'busy';
        let editor;
        if (p.Type === 'bool') {
          editor = <BooleanEditor value={current === true} disabled={disabled} ariaLabel={p.Name}
            onChange={(v) => { void commit({ [p.Name]: v }); }} />;
        } else if (p.Type === 'enum') {
          const options = (p.Enum ?? []).map(String);
          editor = <EnumEditor value={String(current)} options={options} disabled={disabled} ariaLabel={p.Name}
            onChange={(v) => { void commit({ [p.Name]: v }); }} />;
        } else {
          editor = <NumberEditor value={Number(current)} unit={desc?.unit} min={desc?.min} max={desc?.max}
            step={desc?.step} liveCommit={false} disabled={disabled} ariaLabel={p.Name}
            onChange={(v) => { void commit({ [p.Name]: v }); }} />;
        }
        return (
          <InspectorRow key={p.Name} label={desc?.label ?? p.Name} labelTitle={p.Name}>
            {editor}
          </InspectorRow>
        );
      })}
      {status.kind === 'error' && (
        <Typography sx={{ px: 1, pt: 0.5, fontSize: FS.label, color: ERROR }}>{status.text}</Typography>
      )}
      {status.kind === 'info' && (
        <Typography sx={{ px: 1, pt: 0.5, fontSize: FS.label, color: status.text.startsWith('Applied') ? WARN : INK_LOW }}>
          {status.text}
        </Typography>
      )}
      {status.kind === 'busy' && (
        <Typography sx={{ px: 1, pt: 0.5, fontSize: FS.label, color: INK_LOW }}>Generating…</Typography>
      )}
    </Box>
  );
}

fieldRendererRegistry.register({
  componentType: PARAMETRIC_COMPONENT_TYPE,
  fieldName: 'Values',
  component: ParametricValuesField,
});
