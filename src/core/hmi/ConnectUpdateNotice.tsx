// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ConnectUpdateNotice — the one line that says a newer CONNECT exists (plan-363 Phase 8).
 *
 * Sits in the ConnectPanel header among the other operational truths (active profile, historian
 * fault), because "the gateway you are talking to is out of date" is one of them: it is visible
 * without opening a window, and it points at the place that can act on it.
 *
 * Everything about it is deliberately cheap. It issues **no request of its own**: the running
 * version arrives with the `/health` the panel already performs, and the available one with the
 * release-manifest probe `ConnectDownloadLinks` already runs once per session. The `/update/status`
 * endpoint is never touched here — plan-343 T26 pins this panel to zero `/update/` traffic, open or
 * closed, and that contract stands.
 *
 * It is also strictly an announcement: nothing here starts an update. The whole line is one button
 * (message and action are the same target) and it opens the CONNECT settings window, where the
 * plan-343 flow asks for an explicit confirmation before anything is downloaded or swapped.
 *
 * When the installation cannot update itself, the line does not fall silent — it says why, or,
 * when the gateway is too old to name a reason, offers the manual download instead. An operator who
 * can see that something newer exists must always be given a way to get there.
 */

import { useSyncExternalStore } from 'react';
import { Box, Typography, Button } from '@mui/material';
import SystemUpdateAlt from '@mui/icons-material/SystemUpdateAlt';
import { subscribeConnectStore, getConnectSnapshot } from './connect-store';
import { useConnectDownloads } from './use-connect-downloads';
import { resolveUpdateAvailability } from './connect-update-available';
import { ISA_AMBER } from './isa-colors';

// The action reads as a button, not as a link in a sentence: a hairline amber outline in the same
// amber as the notice, sized to the 10px header row so the row keeps its single-line height.
const ACTION_SX = {
  minWidth: 0,
  height: 16,
  px: 0.75,
  py: 0,
  fontSize: 10,
  lineHeight: 1.4,
  textTransform: 'none',
  flexShrink: 0,
  color: ISA_AMBER,
  borderColor: `${ISA_AMBER}66`,
  '&:hover': { borderColor: ISA_AMBER, backgroundColor: `${ISA_AMBER}14` },
  '& .MuiButton-startIcon': { ml: 0, mr: 0.5 },
} as const;

export function ConnectUpdateNotice({ onOpenSettings }: { onOpenSettings: () => void }) {
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const { stable } = useConnectDownloads();

  const availability = resolveUpdateAvailability({
    runningVersion: snap.serverVersion,
    available: stable,
    updateSupported: snap.updateSupported,
    updateReason: snap.updateReason,
  });
  if (!availability) return null;

  const versions = `Update available - ${availability.runningVersion} → ${availability.availableVersion}`;

  // The whole announcement is the control: message and action are one target, so there is no
  // sentence-plus-link to read in two steps and nothing left to align against each other.
  if (availability.supported) {
    return (
      <Box sx={{ display: 'flex', mt: 0.25, minWidth: 0 }}>
        <Button
          size="small"
          variant="outlined"
          startIcon={<SystemUpdateAlt sx={{ fontSize: 12 }} />}
          onClick={onOpenSettings}
          title={versions}
          sx={ACTION_SX}
        >
          {versions}
        </Button>
      </Box>
    );
  }

  if (!availability.reasonSentence) {
    // An older gateway reports neither support nor a reason. Naming a newer build without any
    // route to it would be a dead end, so the manual download stands in for the missing flow.
    return (
      <Box sx={{ display: 'flex', mt: 0.25, minWidth: 0 }}>
        <Button
          component="a"
          href={availability.downloadUrl}
          target="_blank"
          rel="noreferrer"
          size="small"
          variant="outlined"
          startIcon={<SystemUpdateAlt sx={{ fontSize: 12 }} />}
          title={`${versions} - download`}
          sx={ACTION_SX}
        >
          {versions}
        </Button>
      </Box>
    );
  }

  // The automatic route is closed and the gateway said why. Nothing here is clickable, so the row
  // stays a plain line — a button leading nowhere would be the worse lie. The sentence is truncated
  // to keep it single-line (panel convention) with the full text in the tooltip.
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.25, minWidth: 0 }}>
      <SystemUpdateAlt sx={{ fontSize: 12, color: ISA_AMBER, flexShrink: 0, display: 'block' }} />
      <Typography sx={{ fontSize: 10, color: ISA_AMBER, lineHeight: 1.4, flexShrink: 0 }}>
        {versions}
      </Typography>
      <Typography
        title={availability.reasonSentence}
        sx={{
          fontSize: 10, color: 'text.secondary', lineHeight: 1.4, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        {availability.reasonSentence}
      </Typography>
    </Box>
  );
}
