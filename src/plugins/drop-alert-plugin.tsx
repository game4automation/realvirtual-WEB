// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * DropAlertPlugin — unsupported-part cards in the right-side messages panel
 * (plan-2022), in the same form as the collision cards and directly below them
 * (order 7 against their 6): it is the same kind of finding.
 *
 * One TileCard per LATCHED report, fed by the drop manager via
 * `drop-alert-store`. A card persists after the part is supported again (it is
 * the finding, not a live state) until one of:
 *   - the card's **OK** — acknowledges exactly this part (it returns on the
 *     next tick while the part is still unsupported),
 *   - the card's **Ignore** — mutes every part of that SOURCE for the rest of
 *     the current run,
 *   - a rising `ResetDrops` edge from the PLC,
 *   - a model change.
 *
 * Clicking a card frames the camera on the part and flashes it in the warning
 * color (`pulseSeverityOutline`); the PERSISTENT silhouette is the OutlinePass
 * status outline, owned by the manager.
 */

import type { MouseEvent } from 'react';
import { Box, Button } from '@mui/material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import { useDropAlert, type DropAlertView } from '../core/hmi/drop-alert-store';
import { TileCard } from '../core/hmi/TileCard';
import { pulseSeverityOutline } from '../core/hmi/severity-pulse';

/** Format a performance.now() timestamp to a wall-clock HH:MM:SS string. */
function formatSince(since: number): string {
  const epochMs = since + (Date.now() - performance.now());
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function subtitleOf(view: DropAlertView): string {
  const origin = view.sourceName ? `from ${view.sourceName}` : 'pre-placed';
  const at = view.atMm.map((v) => Math.round(v)).join(' / ');
  return `${origin} · at ${at} mm${view.deleted ? ' · removed' : ''}`;
}

function CardActions({ viewer, view }: { viewer: UISlotProps['viewer']; view: DropAlertView }) {
  // TileCard contract: footer buttons must not trigger the card-body click.
  const acknowledge = (e: MouseEvent) => {
    e.stopPropagation();
    viewer.dropManager?.acknowledge(view.muKey);
  };
  const ignoreSource = (e: MouseEvent) => {
    e.stopPropagation();
    viewer.dropManager?.ignoreSource(view.sourceName);
  };
  return (
    <>
      <Button
        size="small"
        variant="contained"
        color="warning"
        data-testid="drop-ok"
        onClick={acknowledge}
        sx={{ textTransform: 'none', fontSize: 12, py: 0.25, minWidth: 48 }}
      >
        OK
      </Button>
      {view.sourceName ? (
        <Button
          size="small"
          variant="outlined"
          color="warning"
          data-testid="drop-ignore-source"
          onClick={ignoreSource}
          sx={{ textTransform: 'none', fontSize: 12, py: 0.25, ml: 1 }}
        >
          Ignore {view.sourceName}
        </Button>
      ) : null}
    </>
  );
}

// ─── Panel ──────────────────────────────────────────────────────────────

export function DropAlertPanel({ viewer }: UISlotProps) {
  const snap = useDropAlert();
  if (snap.drops.length === 0) return null;

  return (
    <Box
      data-ui-panel
      data-testid="drop-alert-panel"
      sx={{ pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}
    >
      {snap.drops.map((v) => (
        <Box key={v.muKey} data-testid="drop-card">
          <TileCard
            title={`Unsupported part: ${v.muName}`}
            subtitle={subtitleOf(v)}
            severity="warning"
            icon="warning"
            timestamp={formatSince(v.since)}
            componentPath={v.nodePath ?? undefined}
            onAction={v.nodePath
              ? () => pulseSeverityOutline(viewer, [v.nodePath as string], 'warning')
              : undefined}
            actions={<CardActions viewer={viewer} view={v} />}
          />
        </Box>
      ))}
    </Box>
  );
}

// ─── Plugin ─────────────────────────────────────────────────────────────

export class DropAlertPlugin implements RVViewerPlugin {
  readonly id = 'drop-alert';
  readonly slots: UISlotEntry[] = [
    // Directly below the collision cards (order 6) in the messages slot.
    { slot: 'messages', component: DropAlertPanel, order: 7 },
  ];
}
