// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-510 — permanent POSITIVE fixture of the HMI design lint rule
 * (tests/hmi-design-lint.node.test.ts): the sanctioned way to write the same
 * UI. Must lint with 0 errors. Never imported by the app.
 */

import { Box, TextField } from '@mui/material';
import { ACCENT, FS, ICON_SIZE, INK_LOW } from '../../../src/core/hmi/shared-sx';

export function GoodFixture({ dense }: { dense: boolean }) {
  return (
    <Box
      sx={{
        color: INK_LOW,
        border: `1px solid ${ACCENT}`,
        fontSize: dense ? FS.micro : FS.label,
        '& svg': { fontSize: ICON_SIZE.sm },
        width: '100%',
        px: 1,
        gap: 0.5,
      }}
    >
      <TextField type="text" slotProps={{ htmlInput: { inputMode: 'decimal' } }} />
    </Box>
  );
}
