// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * VariantCompareDialog — the read-only compare table of Concept D (plan-2013), opened from
 * the toolbar dropdown ("Compare differences…").
 *
 * One row per field ANY variant varies, one column per variant. A cell shows the variant's
 * value, or `·` when it inherits Base. Deliberately NOT editable (the field popover and the
 * inspector row are the two write paths) and deliberately WITHOUT a "only value
 * differences" filter: an override that currently equals Base would be the first thing such
 * a filter hides, and it is exactly what must stay findable (Codex P0 #3). Those cells
 * carry a `=` tag instead.
 *
 * A row whose node is not in this configuration any more is marked "target missing" rather
 * than dropped — orphaned overrides must be visible in one place (Codex).
 *
 * Clicking a row selects the node, so the table is also a way into the inspector.
 */

import { useMemo, useSyncExternalStore } from 'react';
import { Box, Dialog, DialogContent, DialogTitle, IconButton, Tooltip, Typography } from '@mui/material';
import { Close } from '@mui/icons-material';
import type { RVViewer } from '../../core/rv-viewer';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import { formatDisplayValue } from '../../core/hmi/rv-inspector-helpers';
import { ACCENT, DIVIDER, ERROR, FS, INK_LOW, INK_MID, WARN } from '../../core/hmi/shared-sx';
import { diffRows, type VariantDiffRow } from '../../core/variants/rv-variant-model';
import { viewerParamFieldEnv } from '../../core/params/rv-param-apply';
import type { VariantsRuntime } from './variants-runtime';
import { baseValueOf, fieldIdOf, isCompareOpen, setCompareOpen, subscribeVariantUi, variantUiVersion } from './variant-ui';

const FIELD_W = 220;
const CELL_W = 130;

interface Row extends VariantDiffRow {
  readonly id: string;
  readonly path: string | null;
  readonly unit: string | null;
  readonly missing: boolean;
}

export function VariantCompareTable({ viewer, runtime }: { viewer: RVViewer; runtime: VariantsRuntime }) {
  const store = runtime.store;
  const version = useSyncExternalStore(store.subscribe.bind(store), () => store.version);
  const variants = store.block.variants;
  const scene = store.sceneVariant;

  const rows: Row[] = useMemo(() => {
    return diffRows(store.block, (k) => {
      const state = scene && store.variant(scene)?.overrides.some((o) => o.address === k.address && o.component === k.component && o.field === k.field)
        ? 'overridden' as const
        : 'none' as const;
      return baseValueOf(runtime, k, state) ?? null;
    }).map((row) => {
      const node = runtime.service.resolve(row);
      return {
        ...row,
        id: fieldIdOf(row),
        path: node ? viewer.registry?.getPathForNode(node) ?? null : null,
        unit: viewerParamFieldEnv.fieldInfo(row.component, row.field)?.unit ?? null,
        missing: node === null,
      };
    });
    // `version` is the store's change signal — the rows are derived from the block.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime, viewer, store, scene, version]);

  const select = (row: Row): void => {
    if (!row.path) return;
    viewer.selectionManager?.select?.(row.path);
  };

  if (variants.length === 0) {
    return <Typography sx={{ fontSize: FS.body, color: INK_LOW }}>This document has no variants.</Typography>;
  }

  return (
    <Box role="table" aria-label="Variant differences" sx={{ minWidth: 'max-content' }}>
      <Box role="row" sx={{ display: 'flex', borderBottom: `1px solid ${DIVIDER}` }}>
        <Box role="columnheader" sx={{ width: FIELD_W, minWidth: FIELD_W, p: 0.75, fontSize: FS.label, fontWeight: 600 }}>Field</Box>
        <Box role="columnheader" sx={{ width: CELL_W, minWidth: CELL_W, p: 0.75, fontSize: FS.label, fontWeight: 600, color: scene === null ? ACCENT : undefined }}>
          Base{scene === null ? ' · in scene' : ''}
        </Box>
        {variants.map((v) => (
          <Box key={v.id} role="columnheader" sx={{ width: CELL_W, minWidth: CELL_W, p: 0.75, fontSize: FS.label, fontWeight: 600, borderLeft: `1px solid ${DIVIDER}`, color: scene === v.id ? ACCENT : undefined }}>
            {v.name}{scene === v.id ? ' · in scene' : ''}
          </Box>
        ))}
      </Box>
      {rows.map((row) => {
        const baseValue = row.base?.kind === 'value' ? row.base.value : null;
        return (
          <Box
            key={row.id}
            role="row"
            data-testid="variant-compare-row"
            onClick={() => select(row)}
            sx={{ display: 'flex', borderBottom: `1px solid ${DIVIDER}`, cursor: row.path ? 'pointer' : 'default', '&:hover': { bgcolor: 'rgba(255,255,255,0.03)' } }}
          >
            <Box role="cell" sx={{ width: FIELD_W, minWidth: FIELD_W, p: 0.75, fontSize: FS.label }}>
              <Typography sx={{ fontSize: FS.label, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {(row.path ?? row.address).split('/').pop()} · {row.component}.{row.field}
              </Typography>
              {row.missing && (
                <Typography data-testid="variant-compare-missing" sx={{ fontSize: FS.micro, color: ERROR }}>
                  target missing — the value is kept
                </Typography>
              )}
            </Box>
            <Box role="cell" sx={{ width: CELL_W, minWidth: CELL_W, p: 0.75, fontSize: FS.label, fontFamily: 'monospace', color: INK_MID }}>
              {baseValue === null ? '—' : formatDisplayValue(baseValue)}
              {row.unit ? <Box component="span" sx={{ ml: 0.5, color: INK_LOW }}>{row.unit}</Box> : null}
            </Box>
            {variants.map((v) => {
              const value = row.values[v.id];
              const equalsBase = value !== undefined && baseValue !== null && Object.is(baseValue, value);
              return (
                <Box key={v.id} role="cell" sx={{ width: CELL_W, minWidth: CELL_W, p: 0.75, fontSize: FS.label, fontFamily: 'monospace', borderLeft: `1px solid ${DIVIDER}`, color: value === undefined ? INK_LOW : equalsBase ? WARN : ACCENT }}>
                  {value === undefined ? '·' : formatDisplayValue(value)}
                  {equalsBase && (
                    <Tooltip title="Explicitly set, currently equal to Base">
                      <Box component="span" data-testid="variant-compare-equals-base" sx={{ ml: 0.5, fontWeight: 700 }}>=</Box>
                    </Tooltip>
                  )}
                </Box>
              );
            })}
          </Box>
        );
      })}
      {rows.length === 0 && (
        <Typography sx={{ p: 1, fontSize: FS.label, color: INK_LOW }}>No variant sets a value yet.</Typography>
      )}
    </Box>
  );
}

function CompareHost({ viewer, runtime }: { viewer: RVViewer; runtime: VariantsRuntime }) {
  useSyncExternalStore(subscribeVariantUi, variantUiVersion);
  if (!isCompareOpen()) return null;
  return (
    <Dialog open fullWidth maxWidth="lg" onClose={() => setCompareOpen(false)} aria-label="Variant differences">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: FS.body, py: 1 }}>
        <Box sx={{ flex: 1 }}>Variant differences</Box>
        <IconButton size="small" aria-label="Close" onClick={() => setCompareOpen(false)}><Close sx={{ fontSize: 16 }} /></IconButton>
      </DialogTitle>
      <DialogContent sx={{ overflow: 'auto' }}>
        <VariantCompareTable viewer={viewer} runtime={runtime} />
      </DialogContent>
    </Dialog>
  );
}

/** Runtime-bound overlay slot; created only after the lazy variants chunk loads. */
export function createVariantCompareSlot(runtime: VariantsRuntime) {
  return function VariantCompareSlot({ viewer }: UISlotProps) {
    return <CompareHost viewer={viewer} runtime={runtime} />;
  };
}
