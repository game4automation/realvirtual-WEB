// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-usage-list.tsx — the "Used by" list of a signal (plan-566).
 *
 * One list, three places:
 *  - `SignalUsageSection` — the inspector footer block of a selected signal node;
 *  - `SignalUsageButton`  — a small count chip in a hierarchy signal row and a
 *                           CONNECT signal row that opens the list in a popover
 *                           (works for process-image signals without a scene node);
 *  - the tooltip of every signal chip shows the count (rv-signal-badge.tsx).
 *
 * Grouped by kind (Components, Logic steps, PLC, Operator panel, Bindings,
 * CONNECT bridges); every navigable entry jumps to its place. A name that two
 * signal nodes share (F9) is grouped by signal path with a hint.
 */

import { useCallback, useMemo, useState } from 'react';
import { Box, Popover, Tooltip, Typography } from '@mui/material';
import { CallSplit } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import {
  groupSignalUsages,
  isAmbiguousSignalName,
  SIGNAL_USAGE_KIND_LABELS,
  type SignalUsage,
} from '../engine/rv-signal-usage-index';
import { isSignalUsageNavigable, navigateToSignalUsage, useSignalUsages } from './use-signal-usages';
import { InspectorSubheader } from './rv-inspector-blocks';
import { DIVIDER, FS, LINK, WARN } from './shared-sx';

/** Sub-groups of one kind: by signal path when the name is ambiguous, else one group. */
function byPath(usages: readonly SignalUsage[], ambiguous: boolean): Array<{ path: string | null; usages: SignalUsage[] }> {
  if (!ambiguous) return [{ path: null, usages: [...usages] }];
  const map = new Map<string, SignalUsage[]>();
  for (const u of usages) {
    const key = u.signalPath ?? '(by name)';
    const list = map.get(key);
    if (list) list.push(u); else map.set(key, [u]);
  }
  return [...map].map(([path, list]) => ({ path, usages: list }));
}

function UsageRow({ usage, viewer, onNavigate }: { usage: SignalUsage; viewer: RVViewer | null; onNavigate?: () => void }) {
  const navigable = !!viewer && isSignalUsageNavigable(usage);
  const handleClick = useCallback(() => {
    if (!navigable) return;
    navigateToSignalUsage(viewer, usage);
    onNavigate?.();
  }, [navigable, viewer, usage, onNavigate]);
  const title = [
    usage.nodePath ?? usage.plcProgramPath ?? '',
    usage.resolved ? '' : 'Unresolved reference',
    usage.unsaved ? 'The PLC editor has unsaved changes — the line may have moved' : '',
    navigable ? 'Click to go there' : '',
  ].filter(Boolean).join('\n');
  return (
    <Box
      role={navigable ? 'button' : undefined}
      tabIndex={navigable ? 0 : undefined}
      data-testid="signal-usage-row"
      data-usage-kind={usage.kind}
      data-navigable={navigable ? 'true' : 'false'}
      onClick={handleClick}
      onKeyDown={navigable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); } } : undefined}
      title={title || undefined}
      sx={{
        display: 'flex', alignItems: 'baseline', gap: 0.75, px: 1, py: 0.15, minWidth: 0,
        borderRadius: 0.5,
        cursor: navigable ? 'pointer' : 'default',
        ...(navigable ? { '&:hover': { bgcolor: 'rgba(255,255,255,0.05)', '& .rv-usage-label': { color: LINK } } } : {}),
      }}
    >
      <Typography
        className="rv-usage-label"
        sx={{
          fontSize: FS.micro, fontWeight: 500, minWidth: 0, flexShrink: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          color: usage.resolved ? 'text.primary' : WARN,
        }}
      >
        {usage.label}
      </Typography>
      {usage.detail && (
        <Typography sx={{ fontSize: FS.micro, color: 'text.secondary', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {usage.detail}
        </Typography>
      )}
      {usage.written && (
        <Typography sx={{ fontSize: 9, color: 'text.disabled', flexShrink: 0 }}>writes</Typography>
      )}
    </Box>
  );
}

/** The grouped list itself. `onNavigate` lets a popover close after a jump. */
export function SignalUsageList({ viewer, name, usages, onNavigate }: {
  viewer: RVViewer | null;
  name: string;
  usages: readonly SignalUsage[];
  onNavigate?: () => void;
}) {
  const ambiguous = isAmbiguousSignalName(viewer?.signalStore, name);
  const groups = useMemo(() => groupSignalUsages(usages), [usages]);
  if (usages.length === 0) {
    return (
      <Typography data-testid="signal-usage-empty" sx={{ fontSize: FS.micro, color: 'text.disabled', px: 1, py: 0.5 }}>
        Not used anywhere in this model.
      </Typography>
    );
  }
  return (
    <Box data-testid="signal-usage-list" sx={{ pb: 0.5 }}>
      {ambiguous && (
        <Typography data-testid="signal-usage-ambiguous" sx={{ fontSize: FS.micro, color: WARN, px: 1, py: 0.25 }}>
          Several signals share this name — usages are grouped by signal path.
        </Typography>
      )}
      {groups.map((g) => (
        <Box key={g.kind} data-testid={`signal-usage-group-${g.kind}`} sx={{ pt: 0.25 }}>
          <Typography sx={{ fontSize: 9, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: 'text.disabled', px: 1 }}>
            {SIGNAL_USAGE_KIND_LABELS[g.kind]}
          </Typography>
          {byPath(g.usages, ambiguous).map((sub) => (
            <Box key={sub.path ?? ''}>
              {sub.path !== null && (
                <Typography sx={{ fontSize: 9, color: 'text.disabled', fontFamily: 'monospace', px: 1 }}>{sub.path}</Typography>
              )}
              {sub.usages.map((u, i) => (
                <UsageRow key={`${u.kind}:${u.nodePath ?? u.plcProgramPath ?? u.connectBridgeKey ?? ''}:${u.field ?? ''}:${u.line ?? ''}:${i}`} usage={u} viewer={viewer} onNavigate={onNavigate} />
              ))}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

/** Inspector footer block "Used by (N)" of a signal (F6). Renders nothing for a non-signal. */
export function SignalUsageSection({ viewer, name }: { viewer: RVViewer | null; name: string | null }) {
  const usages = useSignalUsages(viewer, name);
  if (!viewer || !name) return null;
  return (
    <Box data-testid="signal-usage-section" sx={{ pb: 0.75, borderTop: `1px solid ${DIVIDER}` }}>
      <InspectorSubheader>{`Used by (${usages.length})`}</InspectorSubheader>
      <SignalUsageList viewer={viewer} name={name} usages={usages} />
    </Box>
  );
}

/**
 * Count chip that opens the "Used by" list in a popover (R1) — for a hierarchy
 * signal row and a CONNECT signal row. Renders nothing while the signal is unused.
 */
export function SignalUsageButton({ viewer, name }: { viewer: RVViewer | null | undefined; name: string | null | undefined }) {
  const usages = useSignalUsages(viewer, name);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  if (!viewer || !name || usages.length === 0) return null;
  return (
    <>
      <Tooltip title={`Used by ${usages.length} — click to list`} placement="top" enterDelay={400}>
        <Box
          component="button"
          type="button"
          data-testid="signal-usage-button"
          aria-label={`Used by ${usages.length}`}
          onClick={(e: React.MouseEvent<HTMLElement>) => { e.stopPropagation(); setAnchor(e.currentTarget); }}
          onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
          onDoubleClick={(e: React.MouseEvent) => e.stopPropagation()}
          sx={{
            display: 'inline-flex', alignItems: 'center', gap: 0.25, flexShrink: 0,
            height: 16, px: 0.5, ml: 0.25, border: '1px solid rgba(255,255,255,0.14)', borderRadius: '2px',
            bgcolor: 'transparent', color: 'text.secondary', fontSize: 10, cursor: 'pointer',
            '&:hover': { color: LINK, borderColor: LINK },
          }}
        >
          <CallSplit sx={{ fontSize: 10 }} />
          {usages.length}
        </Box>
      </Tooltip>
      <Popover
        open={anchor !== null}
        anchorEl={anchor}
        onClose={close}
        onClick={(e) => e.stopPropagation()}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { minWidth: 240, maxWidth: 380, maxHeight: 360, overflow: 'auto', py: 0.5 } } }}
      >
        <Typography sx={{ fontSize: FS.label, fontWeight: 600, px: 1, pb: 0.25 }} data-testid="signal-usage-popover-title">
          {name} — used by {usages.length}
        </Typography>
        <SignalUsageList viewer={viewer} name={name} usages={usages} onNavigate={close} />
      </Popover>
    </>
  );
}
