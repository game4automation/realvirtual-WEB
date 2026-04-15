// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { memo, type ReactNode } from 'react';
import { IconButton, Tooltip, Badge } from '@mui/material';

export interface NavButtonProps {
  icon: ReactNode;
  label: string;
  badge?: number;
  active?: boolean;
  onClick?: () => void;
}

/** Reusable nav button for the left ButtonPanel. */
export const NavButton = memo(function NavButton({ icon, label, badge, active, onClick }: NavButtonProps) {
  return (
    <Tooltip title={label} placement="right">
      <IconButton
        size="medium"
        onClick={onClick}
        sx={{
          color: active ? 'primary.main' : 'text.secondary',
          bgcolor: active ? 'rgba(79, 195, 247, 0.12)' : 'transparent',
          '&:hover': {
            color: 'primary.main',
            bgcolor: 'rgba(79, 195, 247, 0.08)',
          },
        }}
      >
        <Badge badgeContent={badge || undefined} color="error" max={99}>
          {icon}
        </Badge>
      </IconButton>
    </Tooltip>
  );
});
