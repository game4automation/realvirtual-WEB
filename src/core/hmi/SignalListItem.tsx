// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SignalListItem — the standard extended signal row for the WebViewer HMI.
 *
 * Two-line entry: the signal name on top, a muted monospace subtitle
 * (`address · dataType · comment`, each optional) below, and the standard
 * SignalBadge status chip trailing. Reused everywhere a signal is listed —
 * the ConnectPanel signal list, the signal-binding search overlay, and any
 * future signal picker — so the presentation stays consistent.
 *
 * `raw` is optional: omit it and the trailing SignalBadge self-tracks the live
 * value (viewer + name). Callers that already poll can pass `raw` through.
 */

import { Box, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material';
import type { RVViewer } from '../rv-viewer';
import { SignalBadge, type SignalDirection } from './rv-signal-badge';

export function SignalListItem({
  viewer, name, direction, plcType, address, dataType, comment, raw, onClick, sx, role, ariaLabel,
  interfaceId, topic, origin,
  optionId, ariaSelected, ariaDisabled, ariaSetSize, ariaPosInSet, ariaDescribedBy,
}: {
  viewer?: RVViewer;
  name: string;
  direction: SignalDirection;
  plcType?: string;
  address?: string;
  dataType?: string;
  comment?: string;
  raw?: boolean | number | undefined;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  sx?: SxProps<Theme>;
  role?: string;
  ariaLabel?: string;
  /**
   * Provider identity of the listed signal. Forwarded to the badge so a drag
   * STARTED IN A PICKER carries the same provenance a drag from the CONNECT
   * list carries — this row used to drop it, and every picker drag arrived
   * without an interface (plan-341 F5).
   */
  interfaceId?: string;
  topic?: string;
  origin?: 'connect' | 'internal';
  /**
   * Listbox ARIA, set when this row is an OPTION of a combobox-controlled list
   * (SignalSearchOverlay, plan-341 §2.8 d). They belong on the element that
   * carries `role="option"` — `aria-activedescendant` resolves against `id`,
   * and a screen reader reads position from THIS element, not from an ancestor.
   * `ariaSetSize`/`ariaPosInSet` count items only: the virtualized list mixes
   * group headers into the same index space, so the raw index would announce a
   * total nobody can see.
   */
  optionId?: string;
  ariaSelected?: boolean;
  ariaDisabled?: boolean;
  ariaSetSize?: number;
  ariaPosInSet?: number;
  /**
   * Id of the element holding the reason this option is refused. A DESCRIPTION,
   * not part of the name: the name stays the bare signal name so "click the
   * option called X" keeps working for users and tests alike, while the reason
   * is still spoken right after it.
   */
  ariaDescribedBy?: string;
}) {
  const subtitle = [address, dataType, comment].filter(Boolean).join('  ·  ');
  return (
    <Box
      onClick={onClick}
      role={role}
      id={optionId}
      aria-label={ariaLabel}
      aria-selected={ariaSelected}
      aria-disabled={ariaDisabled ? true : undefined}
      aria-describedby={ariaDescribedBy}
      aria-setsize={ariaSetSize}
      aria-posinset={ariaPosInSet}
      sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0, ...sx }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}
        </Typography>
        {subtitle && (
          <Typography noWrap sx={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {subtitle}
          </Typography>
        )}
      </Box>
      <SignalBadge
        viewer={viewer}
        signalName={name}
        direction={direction}
        plcType={plcType}
        raw={raw}
        dragSource={interfaceId ? { interfaceId, topic } : undefined}
        origin={origin}
      />
    </Box>
  );
}
