// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-510 — permanent NEGATIVE fixture of the HMI design lint rule
 * (tests/hmi-design-lint.node.test.ts). Every construct below must be reported;
 * the test pins the exact count per selector. Never imported by the app.
 */

import type { ReactNode } from 'react';
import { Box } from '@mui/material';

function Txt({ fontSize, children }: { fontSize: number; children?: ReactNode }) {
  return <span style={{ fontSize }}>{children}</span>;
}

export function BadFixture({ dense, rgb }: { dense: boolean; rgb: string }) {
  return (
    <Box
      sx={{
        color: '#123456', // hex 1
        bgcolor: '#abc', // hex 2
        outlineColor: 'rgba(255,255,255,0.5)', // rgba 1
        border: '1px solid rgba(0,0,0,0.2)', // rgba 2
        boxShadow: `0 0 0 1px rgba(${rgb},0.2)`, // template rgba 1
        fontSize: 12, // fontSize 1
        '& .x': { fontSize: dense ? 10 : 11 }, // fontSize 2 + 3 (ternary)
        pl: '80px', // px 1
        gap: '4px', // px 2
        width: '42%', // percent 1
      }}
    >
      <Txt fontSize={12}>jsx fontSize 1</Txt>
      <input type="number" />
      <input type={'number'} />
    </Box>
  );
}
