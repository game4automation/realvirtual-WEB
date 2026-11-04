// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AgentEyeMonitorBadge — the entry point to the Agent Eye Monitor (plan-481).
 *
 * ## Why it is BESIDE the AI button, not the AI button (D-U4)
 *
 * The activity bar's AI button is visible with or without a bridge, and a click
 * takes people who have never heard of CONNECT to its setup (plan-366 Phase 6).
 * Its handler keeps that entry available; the monitor has its own small badge
 * in the status row anchored next to it.
 *
 * ## When it renders
 *
 * Only while the bridge is CONNECTED and the agent is actually working (a tool
 * call is in flight) — the same condition `AiActivityOverlay` uses. An agent
 * artefact parked on the scene at rest is noise; the monitor earns a permanent
 * pixel only while something is driving the scene. The PANEL stays mounted
 * independently, so a monitor opened during a call keeps showing its captures
 * after the call ends.
 *
 * The eye and status share a centered row anchored to the activity-bar icon.
 */

import { Badge, IconButton, Tooltip, Box } from '@mui/material';
import { PhotoCameraBack } from '@mui/icons-material';
import { uiBlur } from './rv-ui-blur';
import { useMcpBridge } from '../../hooks/use-mcp-bridge';
import { useAiActivity } from './ai-activity-store';
import {
  useAgentEyeFrames,
  useAgentEyeUnseenCount,
  useAgentEyeMonitorOpen,
  markAgentEyeSeen,
  toggleAgentEyeMonitor,
} from './agent-eye-monitor-store';

export function AgentEyeMonitorBadge() {
  const mcp = useMcpBridge();
  const activity = useAiActivity();
  const frames = useAgentEyeFrames();
  const unseen = useAgentEyeUnseenCount();
  const open = useAgentEyeMonitorOpen();

  const latest = frames[0];
  const label = latest
    ? `Agent Eye — ${frames.length} capture(s), latest ${latest.source}`
    : 'Agent Eye — nothing captured for the agent yet';

  const onClick = () => {
    markAgentEyeSeen();
    toggleAgentEyeMonitor();
  };

  // Connected AND working — see "When it renders" above. After the hooks, so the
  // hook order stays stable across the visible/hidden switch.
  // plan-668: only while AI control is on — a connected CONNECT channel alone is no AI.
  if (!mcp.connected || !(mcp.aiEnabled ?? mcp.enabled) || !activity) return null;

  return (
    <Box
      data-testid="agent-eye-badge-anchor"
      sx={{
        flexShrink: 0,
        // The row is inert; only the button below opts back in, so the badge
        // never turns into an invisible click shield over the scene.
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
      }}
    >
      {/* Announcement region for auto-open (D-U3). Polite: it must never
          interrupt, and it must never move focus. Lives on the badge because a
          capture only ever arrives while the agent is working, i.e. while the
          badge is on screen. */}
      <Box
        aria-live="polite"
        aria-atomic="true"
        sx={{
          position: 'absolute', width: 1, height: 1, overflow: 'hidden',
          clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
        }}
      >
        {latest ? `New agent capture: ${latest.source}` : ''}
      </Box>

      <Tooltip title={label} placement="right">
        <Badge
          badgeContent={unseen}
          color="primary"
          overlap="circular"
          sx={{ pointerEvents: 'auto', '& .MuiBadge-badge': { fontSize: 9, height: 14, minWidth: 14 } }}
        >
          <IconButton
            size="small"
            aria-label={label}
            aria-pressed={open}
            onClick={onClick}
            sx={{
              p: 0.4,
              color: frames.length > 0 ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.45)',
              bgcolor: 'rgba(20,20,20,0.8)',
              border: '1px solid rgba(255,255,255,0.12)',
              // Via the helper, not an inline calc(): identical output, and the
              // blur-token inventory in tests/ui-blur-token.test.tsx counts only
              // INLINE declarations (the helper is the sanctioned route).
              backdropFilter: uiBlur(6),
              '&:hover': { bgcolor: 'rgba(40,40,40,0.92)', color: '#fff' },
            }}
          >
            <PhotoCameraBack sx={{ fontSize: 15 }} />
          </IconButton>
        </Badge>
      </Tooltip>
    </Box>
  );
}
