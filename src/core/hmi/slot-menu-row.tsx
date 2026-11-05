// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { ReactNode } from 'react';
import { ListItemIcon, ListItemText, MenuItem } from '@mui/material';
import { FS, ICON_SIZE, INK_HIGH, INK_LOW, INK_MID } from './shared-sx';

export interface SlotMenuRowProps {
  label: string;
  icon?: ReactNode;
  /** Visible second line: a command refusal reason or a description. */
  secondary?: string;
  disabled?: boolean;
  onClick?: () => void;
  testId?: string;
  active?: boolean;
  /** Extra MenuItem attributes, including preflight hover handlers. */
  attrs?: Record<string, unknown>;
}

/** A visible text row for menu slots. The host closes via data-rv-dropdown-item. */
export function SlotMenuRow({
  label, icon, secondary, disabled, onClick, testId, active, attrs,
}: SlotMenuRowProps) {
  return (
    <MenuItem
      {...attrs}
      dense
      // Keep pointer events and focus so a refusal reason remains available.
      aria-disabled={disabled ? 'true' : 'false'}
      aria-label={label}
      aria-description={secondary}
      data-rv-dropdown-item=""
      data-active={active ? 'true' : 'false'}
      data-testid={testId}
      selected={!!active}
      onClick={() => { if (!disabled) onClick?.(); }}
      sx={{
        fontSize: FS.body,
        gap: 1,
        minHeight: 28,
        whiteSpace: 'normal',
        color: disabled ? INK_LOW : active ? 'primary.main' : INK_HIGH,
        '& .MuiListItemIcon-root': {
          minWidth: 0,
          color: 'inherit',
          '& svg': { fontSize: ICON_SIZE.md },
        },
        ...(disabled ? { cursor: 'default', '&:hover': { bgcolor: 'transparent' } } : null),
      }}
    >
      {icon && (
        <ListItemIcon>
          {icon}
        </ListItemIcon>
      )}
      <ListItemText
        primary={label}
        secondary={secondary}
        sx={{ my: 0.25, minWidth: 0 }}
        slotProps={{
          primary: { sx: { fontSize: FS.body } },
          secondary: { sx: { fontSize: FS.label, color: disabled ? INK_LOW : INK_MID } },
        }}
      />
    </MenuItem>
  );
}
