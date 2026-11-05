// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentModeMenuChip — the mode a document opens in, as a chip that changes it.
 *
 * Looks exactly like the mode chip on a grid card (`DocumentModeChip`, same
 * shared chip definition), plus a small chevron: on the detail pane's preview
 * the chip is the control. A click opens a short menu of the modes the
 * document may open in, the current one checked. Picking one calls `onChange`;
 * what that stores is the caller's business.
 */

import { useState } from 'react';
import { Box, ButtonBase, ListItemIcon, Menu, MenuItem, Typography } from '@mui/material';
import { Check, ExpandMore } from '@mui/icons-material';
import {
  ACCENT, ACCENT_BORDER, FS, INK_HIGH, LABEL_CHIP_ON_PREVIEW_SX, LABEL_CHIP_SX,
} from '../shared-sx';
import { PREVIEW_MODE_CHIP_BOX } from './ProjectsDetailPane';

export interface ModeOption {
  id: string;
  label: string;
}

export interface DocumentModeMenuChipProps {
  /** The mode the document opens in now, or null when it names none. */
  value: string | null;
  /** The modes it may open in, in menu order. */
  options: readonly ModeOption[];
  onChange: (mode: string) => void;
  disabled?: boolean;
}

export function DocumentModeMenuChip({ value, options, onChange, disabled = false }: DocumentModeMenuChipProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const current = options.find(o => o.id === value) ?? null;
  const label = current?.label ?? 'Mode';
  return (
    <>
      <ButtonBase
        data-testid="document-mode-menu-chip"
        aria-haspopup="menu"
        aria-expanded={anchor ? 'true' : undefined}
        aria-label={`Opens in ${current?.label ?? 'the current mode'}. Change mode`}
        title="Mode this document opens in"
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); setAnchor(e.currentTarget); }}
        sx={{
          ...LABEL_CHIP_SX,
          ...LABEL_CHIP_ON_PREVIEW_SX,
          // The preview card's mode-chip box (shared with the plain chip):
          // fixed height, even padding, the chevron inside it.
          ...PREVIEW_MODE_CHIP_BOX,
          fontFamily: 'inherit',
          transition: 'border-color 0.15s, color 0.15s',
          '&:hover': { borderColor: ACCENT_BORDER, color: INK_HIGH },
          '&.Mui-focusVisible': { outline: `1px solid ${ACCENT}`, outlineOffset: 1 },
          ...(anchor ? { borderColor: ACCENT_BORDER, color: INK_HIGH } : {}),
        }}
      >
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</Box>
        <ExpandMore sx={{ fontSize: 12, flexShrink: 0, ml: 0.25, mr: '-2px' }} />
      </ButtonBase>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { mt: 0.5, minWidth: 150 } } }}
      >
        <Typography
          component="li"
          sx={{ fontSize: FS.micro, color: 'text.disabled', textTransform: 'uppercase', letterSpacing: 0.5, px: 1.5, pt: 0.5, pb: 0.25 }}
        >
          Opens in
        </Typography>
        {options.map(o => (
          <MenuItem
            key={o.id}
            selected={o.id === value}
            onClick={() => { setAnchor(null); if (o.id !== value) onChange(o.id); }}
            sx={{ fontSize: FS.body, minHeight: 0, py: 0.5 }}
          >
            <ListItemIcon sx={{ minWidth: '22px !important' }}>
              {o.id === value && <Check sx={{ fontSize: 14, color: ACCENT }} />}
            </ListItemIcon>
            {o.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
