// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { AutoAwesome } from '@mui/icons-material';
import { Button } from '@mui/material';

/** Canonical compact Ask-AI action used by runtime message surfaces. */
export function AskAiButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      size="small"
      startIcon={<AutoAwesome sx={{ fontSize: 15 }} />}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      sx={{ ml: 'auto' }}
    >
      Ask AI
    </Button>
  );
}
