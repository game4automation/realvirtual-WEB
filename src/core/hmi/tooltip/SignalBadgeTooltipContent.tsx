// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * SignalBadgeTooltipContent — what a 3D link badge is offering (plan-422 F5).
 *
 * The badges answer "this object can take a signal", and at a distance that is
 * all they can say: eight of them around one operator panel are eight identical
 * plugs, and the only way to find out which is which used to be to drag onto
 * one and read the drop label. Hovering should be enough.
 *
 * So the card says the two things a person is deciding between: WHICH element
 * this plug belongs to, and WHAT is still free on it. The slot lines reuse the
 * binding vocabulary of the popover the badge opens — same words for the same
 * states, so the hover and the click cannot describe an element differently.
 */

import { Box, Typography } from '@mui/material';
import type { TooltipContentProps } from './tooltip-registry';
import { tooltipRegistry } from './tooltip-registry';
import type { TooltipData } from './tooltip-store';

/** One slot line: the slot's label and whether anything is on it. */
export interface SignalBadgeTooltipSlot {
  label: string;
  /** Bound signal name, or null when the slot is free. */
  boundTo: string | null;
  /** Binding state word (`BINDING_STATE_LABEL`), when the slot is bound. */
  state?: string;
  /** True for a slot the model does not offer (shown greyed, with the reason). */
  unavailable?: boolean;
  reason?: string;
}

export interface SignalBadgeTooltipData extends TooltipData {
  type: 'signal-badge';
  /** Leaf name of the element the badge sits on. */
  label: string;
  /** Overall badge state word, mirroring the badge colour. */
  state: string;
  slots: SignalBadgeTooltipSlot[];
}

const INK = 'rgba(255,255,255,0.68)';
const INK_DIM = 'rgba(255,255,255,0.40)';

export function SignalBadgeTooltipContent({ data }: TooltipContentProps<SignalBadgeTooltipData>) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 160 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
        <Typography
          variant="subtitle2"
          data-testid="signal-badge-tooltip-label"
          sx={{ color: '#fff', fontWeight: 700, fontSize: 13 }}
        >
          {data.label}
        </Typography>
        <Typography variant="caption" sx={{ color: INK, ml: 'auto', fontWeight: 700, fontSize: 11 }}>
          {data.state}
        </Typography>
      </Box>

      {data.slots.length === 0 ? (
        <Typography variant="caption" sx={{ color: INK_DIM, fontSize: 11 }}>
          No signal slots on this element
        </Typography>
      ) : data.slots.map((slot) => (
        <Box
          key={slot.label}
          data-testid="signal-badge-tooltip-slot"
          sx={{ display: 'flex', alignItems: 'baseline', gap: 1, fontSize: 11 }}
        >
          <Typography
            variant="caption"
            sx={{ color: slot.unavailable ? INK_DIM : INK, fontSize: 11, flexShrink: 0 }}
          >
            {slot.label}
          </Typography>
          <Typography
            variant="caption"
            sx={{
              color: slot.unavailable ? INK_DIM : slot.boundTo ? '#4fc3f7' : INK_DIM,
              fontSize: 11,
              ml: 'auto',
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={slot.boundTo ?? undefined}
          >
            {slot.unavailable
              ? (slot.reason ?? 'unavailable')
              : slot.boundTo
                ? `${slot.boundTo}${slot.state ? ` · ${slot.state}` : ''}`
                : 'free'}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

tooltipRegistry.register({
  contentType: 'signal-badge',
  // The badge tooltip must win against the component tooltips of the object it
  // sits on: the pointer is over the PLUG, and that is what the answer is about.
  priority: 1,
  component: SignalBadgeTooltipContent as never,
});
