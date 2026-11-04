// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * PathNetworkToolbar — the "Path network" tool of the left authoring toolbar
 * (plan-628 Phase 5). One button opens a NON-modal panel (the canvas stays
 * clickable for the armed tool) with
 *
 * - the built-in catalog (inline-SVG thumbnails): a click appends at the
 *   selected block's free end, or arms the ghost / junction tool;
 * - the selected block (inspector building blocks): kind, parameters (only
 *   while the block is unedited), "edited", Reset to template, Rotate, Select
 *   chain, Delete; with several blocks selected (Shift-click, chain) the card
 *   says how many and Delete removes all of them in one step (plan-628 8.9).
 *
 * Every action is a `layout.path.*` command through the interaction
 * controller — this file holds no write logic. While the simulation runs the
 * catalog is disabled with "Stop the simulation to edit the path network".
 */

import { useCallback, useEffect, useState, useSyncExternalStore, type DragEvent as ReactDragEvent, type ReactNode } from 'react';
import { Box, Button, IconButton, Paper, Popper, Tooltip, Typography } from '@mui/material';
import { Route } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { DragNumberField } from '../../core/hmi/DragNumberField';
import { InspectorActionRow, InspectorSubheader } from '../../core/hmi/rv-inspector-blocks';
import { InspectorRow } from '../../core/hmi/rv-inspector-row';
import { parseDecimal } from '../../core/hmi/rv-number-format';
import { uiBlur } from '../../core/hmi/rv-ui-blur';
import { ACCENT, ACCENT_TINT, CHIP_BORDER, DIVIDER, ERROR, FS, ICON_SIZE, INK_LOW, INK_MID, PANEL_SURFACE } from '../../core/hmi/shared-sx';
import { isJunctionEntry, PATH_CATALOG, PATH_NETWORK_LOCKED_HINT, type PathCatalogEntry } from './path-network-ui-model';
import type { PathNetworkInteraction, PathNetworkUiState } from './path-network-interaction';
import { PATH_BLOCK_DRAG_TYPE } from './path-network-shared';
import { suppressDragImage } from '../layout-planner/drag-types';

/** Tooltip of the locked catalog (plan §3.3) — defined in the UI model, re-exported for callers. */
export { PATH_NETWORK_LOCKED_HINT };

interface PathNetworkUiHost {
  subscribeInteraction?: (cb: () => void) => () => void;
  readonly interaction: PathNetworkInteraction | null;
}

const EMPTY: PathNetworkUiState = {
  active: false, editable: false, toolId: null, selectedBlock: null, selectedBlocks: [], enteredBlock: null, selectedPath: null, lastError: null, busy: false,
  clickLayout: false, typedText: null,
};

const subscribeNothing = (): (() => void) => () => {};

function useUi(): { ui: PathNetworkInteraction | null; state: PathNetworkUiState } {
  const viewer = useViewer();
  const plugin = viewer.getPlugin<PathNetworkUiHost & { id: string }>('path-network-ui');
  const getInteraction = useCallback(() => plugin?.interaction ?? null, [plugin]);
  const ui = useSyncExternalStore(plugin?.subscribeInteraction ?? subscribeNothing, getInteraction);
  const state = useSyncExternalStore(ui?.subscribe ?? (() => () => {}), ui?.getState ?? (() => EMPTY));
  return { ui, state };
}

// ─── Thumbnails (inline SVG, stroke = currentColor) ──────────────────────

function Thumb({ entry }: { entry: PathCatalogEntry }): ReactNode {
  const s = entry.spec;
  const flip = s.side === 'right';
  let d = '';
  switch (s.kind) {
    case 'straight': d = s.lengthM === 1 ? 'M8 16 H24' : 'M4 16 H28'; break;
    case 'curve': d = s.degrees === 45 ? 'M4 22 H12 Q20 22 25 14' : 'M4 26 H10 Q24 26 24 6'; break;
    case 'diverge': d = 'M4 22 H28 M10 22 Q22 22 24 8'; break;
    case 'merge': d = 'M4 22 H28 M8 8 Q10 22 22 22'; break;
    case 'stub': d = 'M4 24 H28 M16 4 V14 Q16 24 24 24'; break;
  }
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
      <g transform={flip ? 'translate(0 32) scale(1 -1)' : undefined}>
        <path d={d} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" />
      </g>
    </svg>
  );
}

// ─── Block card ──────────────────────────────────────────────────────────

function NumberRow({ label, unit, value, disabled, onCommit, step }: {
  label: string; unit: string; value: number; disabled: boolean; step: number; onCommit: (v: number) => void;
}): ReactNode {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <InspectorRow label={label}>
      <DragNumberField
        value={draft}
        onValueChange={setDraft}
        onCommit={() => {
          const n = parseDecimal(draft);
          if (n === null || !(n > 0) || n === value) { setDraft(String(value)); return; }
          onCommit(n);
        }}
        min={0.1}
        max={100}
        step={step}
        unit={unit}
        disabled={disabled}
        compact
        ariaLabel={label}
      />
    </InspectorRow>
  );
}

function BlockCard({ ui, state }: { ui: PathNetworkInteraction; state: PathNetworkUiState }): ReactNode {
  const b = state.selectedBlock;
  if (!b) {
    const hint = state.enteredBlock
      ? `Inside ${state.enteredBlock} — Esc leaves the block`
      : 'Click a path to select its block (Shift-click adds), double-click to edit a single path, right-click for more';
    return <Typography sx={{ px: 1, py: 0.75, fontSize: FS.label, color: INK_LOW }}>{hint}</Typography>;
  }
  const count = state.selectedBlocks.length;
  if (count > 1) {
    return (
      <Box data-testid="path-block-card">
        <InspectorSubheader>{`${count} blocks selected`}</InspectorSubheader>
        <Typography sx={{ px: 1, pb: 0.5, fontSize: FS.label, color: INK_LOW }}>
          {state.selectedBlocks.join(', ')}
        </Typography>
        <InspectorActionRow>
          <Button size="small" variant="outlined" color="error" data-testid="path-block-delete" disabled={!state.editable} onClick={() => void ui.removeSelected()}>
            {`Delete ${count} blocks`}
          </Button>
        </InspectorActionRow>
      </Box>
    );
  }
  const p = b.params as { lengthM?: number; radiusM?: number; degrees?: number; side?: string };
  // plan-628 8.6: a generated (composition-owned) block is read-only — every write would be refused.
  const writable = state.editable && !b.owner;
  const lockParams = !writable || b.edited || b.junction;
  return (
    <Box data-testid="path-block-card">
      <InspectorSubheader>{`Block ${b.id}`}</InspectorSubheader>
      <InspectorRow label="Kind"><Typography sx={{ fontSize: FS.body }}>{b.kind}</Typography></InspectorRow>
      {p.lengthM !== undefined && (
        <NumberRow label="Length" unit="m" step={0.1} value={p.lengthM} disabled={lockParams} onCommit={(v) => void ui.setSelectedParams({ lengthM: v })} />
      )}
      {p.radiusM !== undefined && (
        <NumberRow label="Radius" unit="m" step={0.1} value={p.radiusM} disabled={lockParams} onCommit={(v) => void ui.setSelectedParams({ radiusM: v })} />
      )}
      {p.degrees !== undefined && (
        <NumberRow label="Angle" unit="°" step={5} value={p.degrees} disabled={lockParams} onCommit={(v) => void ui.setSelectedParams({ degrees: v })} />
      )}
      {p.side !== undefined && (
        <InspectorRow label="Side"><Typography sx={{ fontSize: FS.body }}>{p.side}</Typography></InspectorRow>
      )}
      <InspectorRow label="Edited">
        <Typography sx={{ fontSize: FS.body, color: b.edited ? ACCENT : INK_MID }}>{b.edited ? 'yes — parameters locked' : 'no'}</Typography>
      </InspectorRow>
      {b.owner && (
        <InspectorRow label="Generated">
          <Typography data-testid="path-block-owner" sx={{ fontSize: FS.body, color: INK_MID }}>{`read-only (${b.owner})`}</Typography>
        </InspectorRow>
      )}
      <InspectorActionRow>
        {!b.junction && (
          <Button size="small" variant="outlined" sx={{ whiteSpace: 'nowrap' }} disabled={!writable || !b.edited} onClick={() => void ui.resetSelected()}>
            Reset to template
          </Button>
        )}
        {!b.junction && (
          <Tooltip title="Rotate 90° (R, Shift+R the other way)">
            <span>
              <Button size="small" variant="outlined" data-testid="path-block-rotate" disabled={!writable} onClick={() => void ui.rotateSelected()}>
                Rotate
              </Button>
            </span>
          </Tooltip>
        )}
      </InspectorActionRow>
      <InspectorActionRow>
        {!b.junction && (
          <Tooltip title="Select this block and every block downstream of it (stops at junctions)">
            <Button size="small" variant="outlined" sx={{ whiteSpace: 'nowrap' }} data-testid="path-block-select-chain" onClick={() => ui.selectChain()}>
              Select chain
            </Button>
          </Tooltip>
        )}
        <Button size="small" variant="outlined" color="error" data-testid="path-block-delete" disabled={!writable} onClick={() => void ui.removeSelected()}>
          Delete
        </Button>
      </InspectorActionRow>
    </Box>
  );
}

// ─── Toolbar button + panel ──────────────────────────────────────────────

export function PathNetworkToolButton(): ReactNode {
  const { ui, state } = useUi();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!ui || !state.active) return null;
  const open = !!anchor;
  return (
    <>
      <Tooltip title={state.editable ? 'Path network — build AGV paths from blocks' : PATH_NETWORK_LOCKED_HINT} placement="right">
        <IconButton
          size="small"
          aria-label="Path network"
          data-testid="path-network-tool"
          onClick={(e) => setAnchor(open ? null : e.currentTarget)}
          sx={{ p: 0.75, color: open || state.toolId ? 'primary.main' : 'text.secondary' }}
        >
          <Route sx={{ fontSize: ICON_SIZE.lg }} />
        </IconButton>
      </Tooltip>
      <Popper open={open} anchorEl={anchor} placement="right-start" sx={{ zIndex: 1200 }} modifiers={[{ name: 'offset', options: { offset: [0, 8] } }]}>
        <Paper
          data-testid="path-network-panel"
          sx={{ width: 296, bgcolor: `${PANEL_SURFACE} !important`, backdropFilter: uiBlur(8), border: `1px solid ${CHIP_BORDER}`, boxShadow: 'none', pb: 0.5 }}
        >
          <InspectorSubheader>Path network</InspectorSubheader>
          <Tooltip title={state.editable ? '' : PATH_NETWORK_LOCKED_HINT} placement="right">
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0.5, px: 1, py: 0.5, opacity: state.editable ? 1 : 0.4 }}>
              {PATH_CATALOG.map((entry) => {
                const on = state.toolId === entry.id;
                return (
                  <Box
                    key={entry.id}
                    component="button"
                    type="button"
                    title={entry.label}
                    aria-label={entry.label}
                    aria-pressed={on}
                    data-testid={`path-catalog-${entry.id}`}
                    disabled={!state.editable || state.busy}
                    onClick={() => void ui.pickCatalog(on ? null : entry.id)}
                    draggable={state.editable && !state.busy}
                    onDragStart={(e: ReactDragEvent) => {
                      e.dataTransfer.setData(PATH_BLOCK_DRAG_TYPE, entry.id);
                      e.dataTransfer.effectAllowed = 'copy';
                      suppressDragImage(e);
                      ui.beginCatalogDrag(entry.id);
                    }}
                    onDragEnd={() => ui.endCatalogDrag()}
                    sx={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.25,
                      py: 0.5, px: 0.25, cursor: state.editable ? 'pointer' : 'default',
                      color: on ? ACCENT : INK_MID,
                      bgcolor: on ? ACCENT_TINT : 'transparent',
                      border: `1px solid ${on ? ACCENT : DIVIDER}`, borderRadius: 1, font: 'inherit',
                    }}
                  >
                    <Thumb entry={entry} />
                    <Typography component="span" sx={{ fontSize: FS.micro, lineHeight: 1.2, textAlign: 'center' }}>{entry.label}</Typography>
                  </Box>
                );
              })}
            </Box>
          </Tooltip>
          {state.toolId && (
            <Typography sx={{ px: 1, pb: 0.5, fontSize: FS.label, color: INK_LOW }}>
              {isJunctionEntry(PATH_CATALOG.find((e) => e.id === state.toolId)?.spec ?? { kind: 'straight' })
                ? 'Hover a path, click to set it — the side follows the pointer, Esc cancels'
                : 'Click in the scene to place — snaps onto free path ends, R rotates, Esc cancels'}
            </Typography>
          )}
          <Box sx={{ borderTop: `1px solid ${DIVIDER}`, mt: 0.5, pt: 0.5 }}>
            <BlockCard ui={ui} state={state} />
          </Box>
          {state.lastError && (
            <Typography data-testid="path-network-error" sx={{ px: 1, py: 0.5, fontSize: FS.label, color: ERROR }}>{state.lastError}</Typography>
          )}
        </Paper>
      </Popper>
    </>
  );
}
