// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { lazy, Suspense, useState } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { formatVersionFull } from '../../rv-version';
import { getConnectSnapshot } from '../connect-store';

const DiagnosticsDialog = lazy(() => import('../DiagnosticsDialog').then(m => ({ default: m.DiagnosticsDialog })));

export function HelpDiagnosticsTab() {
  const [open, setOpen] = useState(false);
  const connect = getConnectSnapshot();
  const connectVersion = connect.serverVersion
    ? `${connect.serverVersion}${connect.serverBuild ? ` (build ${connect.serverBuild})` : ''}` : 'Not available';
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, p: 1 }}>
      <Typography sx={{ fontSize: 13, color: 'text.primary' }}>realvirtual WEB {formatVersionFull()}</Typography>
      <Typography sx={{ fontSize: 11, color: 'text.secondary', fontFamily: 'monospace' }}>
        CONNECT {connectVersion}
      </Typography>
      <Button variant="contained" size="small" onClick={() => setOpen(true)} sx={{ alignSelf: 'flex-start' }}>
        Save diagnostics…
      </Button>
      {open && (
        <Suspense fallback={null}>
          <DiagnosticsDialog open onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </Box>
  );
}
