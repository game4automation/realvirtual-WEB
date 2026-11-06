// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ConnectChannelRow — plan-668: the state of the `/webviewer` channel to
 * realvirtual CONNECT, shown at the top of Settings ▸ AI and OUTSIDE the AI
 * consent gate. The channel is CONNECT infrastructure (SolidCraft sync, server
 * log, ownership) and is connected whenever CONNECT serves this page, whether or
 * not AI control is on — so its state must be visible without having accepted
 * the AI scope. Only the AI part of the tab (switch, tools, AI client) stays
 * behind the gate.
 *
 * The failure texts (plan-541 § 3.1) live here because a refused or unreachable
 * channel is a channel problem, AI or not.
 */

import { Box, Button, Link, Typography } from '@mui/material';
import { useViewer } from '../../../hooks/use-viewer';
import { useMcpBridge } from '../../../hooks/use-mcp-bridge';
import type { McpBridgePluginAPI } from '../../types/plugin-types';
import type { McpBridgeFailure, McpBridgeSnapshot, McpChannelReason } from '../../../plugins/mcp-bridge-plugin';
import { ERROR, FS, INK_MID, MONO, SUCCESS, WARN } from '../shared-sx';
import { StatRow, SettingsSection } from './settings-helpers';

/** One failure cause as the panel shows it (plan-541 § 3.1). */
interface FailureText {
  status: string;
  hint: string;
  /** Offer the "open the viewer from CONNECT itself" link. */
  localLink?: boolean;
  /** Further lines below the hint. */
  extra?: string[];
}

/** Why the channel is not connected — status + what to do (plan-541 § 3.1). */
export const MCP_FAILURE_TEXT: Readonly<Record<Exclude<McpBridgeFailure, 'none'>, FailureText>> = {
  'pairing-pending': { status: 'Waiting for approval', hint: 'Confirm in the CONNECT tray icon.' },
  'pairing-denied': {
    status: 'Denied by CONNECT',
    hint: 'Remove the origin under Tray ▸ MCP server ▸ AI Bridge origins.',
  },
  'pairing-cooldown': { status: 'Approval timed out', hint: 'Try again in a few minutes.' },
  'pairing-unavailable': {
    status: 'Pairing not available',
    hint: 'This CONNECT has no tray. Add the origin to AllowedOrigins.',
  },
  'origin-not-pairable': {
    status: 'Origin not allowed',
    hint: 'Use https or open the viewer via {connectUrl}.',
    localLink: true,
  },
  'bridge-disabled': {
    status: 'MCP server off',
    hint: 'Tray ▸ MCP server ▸ Enabled, then restart CONNECT.',
  },
  'connect-outdated': {
    status: 'CONNECT too old',
    hint: 'Update CONNECT, or add this origin to AllowedOrigins.',
  },
  unreachable: {
    status: 'CONNECT not reachable',
    hint: 'Is CONNECT running? Allow local network access in the browser. Safari: open {connectUrl}.',
    localLink: true,
    extra: [
      "If CONNECT restricts AllowedOrigins, add this page's origin.",
      'A Content Security Policy (connect-src) on this site may block localhost.',
    ],
  },
  'browser-blocked': {
    status: 'Blocked by the browser',
    hint: 'This browser does not allow the connection. Use Chrome/Edge or open {connectUrl}.',
    localLink: true,
  },
  starting: { status: 'CONNECT is starting', hint: 'Connects automatically.' },
  refused: {
    status: 'Connection refused',
    hint: "Check API key, licence and the browser's local-network permission. Safari: open {connectUrl}.",
    localLink: true,
  },
  'pairing-busy': { status: 'CONNECT is busy', hint: 'Too many approval requests — try again later.' },
  'bridge-full': {
    status: 'Too many viewer tabs',
    hint: 'CONNECT serves at most 8 viewer tabs at once. Close tabs you no longer need.',
  },
};

/** Why the channel is open, as the panel words it. */
const REASON_TEXT: Readonly<Record<Exclude<McpChannelReason, 'none'>, string>> = {
  'connect-origin': 'served by CONNECT',
  ai: 'opened for AI control',
  acquired: 'opened for a connection (e.g. SolidCraft)',
};

/** The page origin as the CONNECT tray prompt names it. Never throws. */
function pageOrigin(): string {
  try { return window.location.origin; } catch { return ''; }
}

/** Is a channel wanted at all? An older snapshot without `channelReason` follows `enabled`. */
function channelWanted(mcp: McpBridgeSnapshot): boolean {
  return mcp.channelReason !== undefined ? mcp.channelReason !== 'none' : mcp.enabled;
}

/** The channel's state label + colour (plan-668 § 3.1). */
export function channelState(mcp: McpBridgeSnapshot): { label: string; color: string; failure: Exclude<McpBridgeFailure, 'none'> | null } {
  const wanted = channelWanted(mcp);
  const failure = wanted && !mcp.connected && mcp.failure !== 'none' ? mcp.failure : null;
  if (mcp.connected) return { label: 'Connected', color: SUCCESS, failure: null };
  if (failure) {
    const pending = failure === 'pairing-pending' || failure === 'starting';
    return { label: MCP_FAILURE_TEXT[failure].status, color: pending ? WARN : ERROR, failure };
  }
  if (mcp.reconnectAttempt > 0) return { label: `Reconnecting (${mcp.reconnectAttempt})...`, color: WARN, failure: null };
  if (wanted) return { label: 'Connecting…', color: WARN, failure: null };
  return { label: 'Not connected', color: INK_MID, failure: null };
}

/** Cause block under the status rows: what failed and what to do about it. */
export function FailureHint({ failure, port, target }: { failure: Exclude<McpBridgeFailure, 'none'>; port: string; target?: string }) {
  const text = MCP_FAILURE_TEXT[failure];
  let localUrl = `http://localhost:${port || '5100'}`;
  try {
    const url = new URL(target ?? '');
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      localUrl = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
    }
  } catch { /* Use the configured port when a target is not available yet. */ }
  const captionSx = { color: INK_MID, fontSize: FS.label } as const;
  return (
    <Box data-testid="mcp-failure-hint" sx={{
      display: 'flex', flexDirection: 'column', gap: 0.5, p: 1,
      borderLeft: `2px solid ${failure === 'pairing-pending' || failure === 'starting' ? WARN : ERROR}`,
    }}>
      {failure === 'pairing-pending' ? (
        <Typography variant="caption" sx={captionSx}>
          Confirm in the realvirtual CONNECT tray icon: “Allow {pageOrigin()}” — then this page
          connects automatically.
        </Typography>
      ) : null}
      <Typography variant="caption" sx={captionSx}>{text.hint.replace('{connectUrl}', localUrl)}</Typography>
      {text.extra?.map((line) => (
        <Typography key={line} variant="caption" sx={captionSx}>{line}</Typography>
      ))}
      {text.localLink ? (
        <Link href={localUrl} target="_blank" rel="noopener noreferrer" variant="caption"
          sx={{ fontFamily: MONO, fontSize: FS.label }}>
          {localUrl}
        </Link>
      ) : null}
    </Box>
  );
}

/** The "CONNECT channel" section — always rendered, consent or not. */
export function ConnectChannelRow() {
  const viewer = useViewer();
  const mcp = useMcpBridge();
  const plugin = viewer.getPlugin<McpBridgePluginAPI>('mcp-bridge');
  const state = channelState(mcp);
  const reason = mcp.channelReason && mcp.channelReason !== 'none' ? REASON_TEXT[mcp.channelReason] : null;

  return (
    <SettingsSection id="connect-channel" title="CONNECT channel">
      <Box data-testid="connect-channel-row" sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <StatRow label="CONNECT channel" value={state.label} color={state.color} />
        {reason && <StatRow label="Why" value={reason} color={INK_MID} />}
        {mcp.target && channelWanted(mcp) && <StatRow label="Target" value={mcp.target} />}
        {!channelWanted(mcp) && !mcp.connected && (
          <Typography variant="caption" sx={{ color: INK_MID, fontSize: FS.label }}>
            Opens by itself when realvirtual CONNECT serves this page, when AI control is on, or when a
            connection (such as SolidCraft) asks for it.
          </Typography>
        )}
      </Box>
      {state.failure && <FailureHint failure={state.failure} port={mcp.port} target={mcp.target} />}
      {channelWanted(mcp) && !mcp.connected && (
        <Button size="small" variant="outlined" onClick={() => plugin?.reconnect()}
          sx={{ alignSelf: 'flex-start', textTransform: 'none' }}>
          Retry Now
        </Button>
      )}
    </SettingsSection>
  );
}
