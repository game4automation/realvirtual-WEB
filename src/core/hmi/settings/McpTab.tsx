// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useEffect, type ReactNode } from 'react';
import { Typography, Box, Button, Switch, TextField } from '@mui/material';
import { useViewer } from '../../../hooks/use-viewer';
import { useMcpBridge, useMcpBridgeLog } from '../../../hooks/use-mcp-bridge';
import type { McpBridgePluginAPI } from '../../types/plugin-types';
import type { McpBridgeRole } from '../../../plugins/mcp-bridge-plugin';
import { INK_MID, SUCCESS, WARN } from '../shared-sx';
import { AiBridgeConsentDialog } from '../AiBridgeGate';
import { grantAiBridgeConsent, hasAiBridgeConsent } from '../ai-consent-store';
import { requestSettingsTab } from '../settings-tab-store';
import { StatRow, SettingsSection, FieldRow } from './settings-helpers';
import { ConnectDownloadLinks } from '../connect-panel-shared';
import { RagStatusSection } from './RagStatusSection';
import { useAiClicks } from '../ai-click-choreography-store';
import { useCommandView } from '../rv-command-view';
import { useFollowAgent, setFollowAgent } from '../follow-agent-store';

/** The default transport: realvirtual CONNECT hosts the MCP endpoint itself, so any
 *  MCP client registers ONE http entry and needs neither Node nor Vite (plan-327 AP5). */
const CONNECT_MCP_SNIPPET = `"realvirtual-CONNECT": {
  "type": "http",
  "url": "http://localhost:5100/mcp"
}`;

/** Emergency fallback only — see doc-ai-integration.md → "Falling back to the Node bridge". */
const NODE_FALLBACK_SNIPPET = `"WebViewerMCP": {
  "command": "node",
  "args": ["<project>/Assets/realvirtual-WebViewer~/mcp-bridge/dist/index.js"]
}`;

const BUILD_CMD = 'cd Assets/realvirtual-WebViewer~/mcp-bridge\nnpm run setup';

/**
 * plan-564: the ownership row. CONNECT keeps several tabs connected and lets ONE
 * of them own the bridge; the rest wait. Transport readiness ("Connected") and
 * ownership are deliberately separate rows. Null hides the row — a gateway that
 * predates standby sends no role.
 */
export function bridgeRoleLabel(
  role: McpBridgeRole | null | undefined,
  claimed = false,
): { label: string; color: string } | null {
  if (role === 'active') return { label: claimed ? 'Active (agent tab)' : 'Active', color: SUCCESS };
  if (role === 'standby') return { label: 'Standby — another tab is in control', color: WARN };
  return null;
}

/** Monospace block with a copy-to-clipboard button. */
function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <Box sx={{ position: 'relative', bgcolor: 'rgba(0,0,0,0.35)', borderRadius: 1, p: 1, pr: 5 }}>
      <Typography component="pre" sx={{
        fontFamily: 'monospace', fontSize: 11, m: 0,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'rgba(255,255,255,0.85)',
      }}>
        {text}
      </Typography>
      <Button size="small" variant="text" onClick={copy}
        sx={{ position: 'absolute', top: 2, right: 2, minWidth: 0, px: 0.75, textTransform: 'none', fontSize: 10 }}>
        {copied ? '✓' : 'Copy'}
      </Button>
    </Box>
  );
}

/** A numbered setup step. */
function SetupStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Typography variant="caption" sx={{ fontWeight: 600, color: 'rgba(255,255,255,0.85)' }}>
        {n}. {title}
      </Typography>
      {children}
    </Box>
  );
}

export function McpTab() {
  const viewer = useViewer();
  const mcp = useMcpBridge();
  const followAgent = useFollowAgent();
  const aiClicks = useAiClicks();
  const aiClicksCommand = useCommandView({ id: 'view.aiClicks', viewer, args: () => ({ on: !aiClicks }) });
  const log = useMcpBridgeLog();
  const mcpPlugin = viewer.getPlugin<McpBridgePluginAPI>('mcp-bridge');
  const [portInput, setPortInput] = useState(mcp.port);
  const [portError, setPortError] = useState(false);
  // plan-668 F6: switching AI control ON needs the one-time consent first.
  const [consentOpen, setConsentOpen] = useState(false);
  const aiEnabled = mcp.aiEnabled ?? mcp.enabled;

  // Sync portInput when mcp.port changes externally
  useEffect(() => { setPortInput(mcp.port); }, [mcp.port]);

  // plan-668: the channel state (target, failure cause, retry) is the ConnectChannelRow above this
  // tab, outside the consent gate; this tab is the AI part only.
  const toggleAi = (on: boolean) => {
    if (on && !hasAiBridgeConsent()) { setConsentOpen(true); return; }
    mcpPlugin?.setEnabled(on);
  };
  const acceptConsent = () => {
    grantAiBridgeConsent();
    setConsentOpen(false);
    mcpPlugin?.setEnabled(true);
  };

  // Full-chain status: the bridge server pushes who's attached (which Claude)
  // and when it was last active. Both CONNECT and the Node bridge send this frame;
  // the legacy Python bridge does not, so these rows stay hidden for it.
  const ss = mcp.serverStatus;
  const aiConnected = !!ss?.clientConnected;
  const aiColor = aiConnected ? '#66bb6a' : '#ef5350';
  const aiLabel = aiConnected ? (ss?.clientName ?? 'connected') : 'no AI client';

  const fmtAgo = (ms: number | null | undefined): string => {
    if (ms == null) return 'idle';
    if (ms < 1500) return 'just now';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    return `${Math.round(m / 60)}h ago`;
  };
  const fmtUptime = (ms: number | undefined): string => {
    if (ms == null) return '?';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  };
  const bridgeLabel = ss ? `pid ${ss.pid} · :${ss.port} · up ${fmtUptime(ss.uptimeMs)}` : '—';
  const role = mcp.connected ? bridgeRoleLabel(mcp.role, mcp.claimed) : null;

  const validatePort = (val: string): boolean => {
    const n = Number(val);
    return Number.isInteger(n) && n >= 1 && n <= 65535;
  };

  const handlePortChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setPortInput(val);
    setPortError(val !== '' && !validatePort(val));
  };

  const handlePortBlur = () => {
    if (portInput !== mcp.port && validatePort(portInput)) {
      // Reconnect if a channel is wanted; otherwise just store the port for the next one.
      if (mcp.connected || (mcp.channelReason ?? (mcp.enabled ? 'ai' : 'none')) !== 'none') mcpPlugin?.reconnect(portInput);
      else mcpPlugin?.setPort(portInput);
    } else if (!validatePort(portInput)) {
      setPortInput(mcp.port);
      setPortError(false);
    }
  };

  const handlePortKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <SettingsSection id="mcp-bridge" title="AI control">
        {/* plan-668: the switch gates AI control only — the CONNECT channel is independent. */}
        <FieldRow label="AI control" hint="Allow AI agents / MCP clients to control this viewer">
          <Switch size="small" checked={aiEnabled} data-testid="ai-control-switch"
            onChange={(_, v) => toggleAi(v)} />
        </FieldRow>
        <AiBridgeConsentDialog
          open={consentOpen}
          onAcknowledge={acceptConsent}
          onConfigure={() => { acceptConsent(); requestSettingsTab(5); }}
          onClose={() => setConsentOpen(false)}
        />

        {/* plan-2220 E8: the AI panel may model in SolidCraft — only the instance the Live Link
            is connected to, and only while it is connected. Default off. Tied to AI control (E15):
            disabled while AI control is off — CONNECT ignores it then. */}
        <FieldRow label="AI may control SolidCraft"
          hint="The AI panel may use the SolidCraft instance this tab's Live Link is connected to. No other tools of your AI setup are used.">
          <Switch size="small" checked={mcp.aiSolidCraft === true} data-testid="ai-solidcraft-switch"
            disabled={!aiEnabled || !mcpPlugin?.setAiSolidCraft}
            onChange={(_, v) => mcpPlugin?.setAiSolidCraft?.(v)} />
        </FieldRow>

        {/* plan-520: fly the camera to what the agent edits while the view is idle. */}
        <FieldRow label="Follow agent" hint="Move the camera to what the AI changes while you are not using the view">
          <Switch size="small" checked={followAgent}
            onChange={(_, v) => setFollowAgent(v)} />
        </FieldRow>
        <FieldRow label="Show AI clicks" hint="Animate the button an AI agent presses. Off = no waiting before each AI action.">
          <Switch size="small" checked={aiClicks} disabled={aiClicksCommand.disabled}
            onChange={() => aiClicksCommand.onClick()} slotProps={{ input: { role: 'switch', 'aria-label': 'Show AI clicks' } }} />
        </FieldRow>

        {/* Status — the FULL chain: browser ⟷ bridge ⟷ AI client. "State" is
            only the browser↔bridge WebSocket leg; "AI client" shows whether a
            live Claude is actually attached (and which one), so a connected
            browser on a host-less bridge no longer looks healthy. */}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <StatRow label="AI control" value={aiEnabled ? 'On' : 'Off'} color={aiEnabled ? SUCCESS : INK_MID} />
          {role && <StatRow label="This tab" value={role.label} color={role.color} />}
          {mcp.connected && ss && (
            <>
              <StatRow label="AI client" value={aiLabel} color={aiColor} />
              <StatRow label="Last AI activity" value={fmtAgo(ss.lastRequestAgoMs)} />
            </>
          )}
          <StatRow label="Tools" value={aiEnabled ? String(mcp.toolCount) : '0 (AI off)'} />
          <StatRow label="Port" value={mcp.port} />
          {mcp.connected && ss && <StatRow label="Bridge" value={bridgeLabel} />}
        </Box>

        {/* No transport picker. CONNECT is the MCP server: it hosts the endpoint and owns the web_*
            tools, so this row asked the operator to choose between the one real answer and two
            fallbacks nobody reaches for unprompted. The Node bridge stays reachable through the port
            field below (18714 Desktop / 18715 Code) and its code is untouched — retiring it is
            plan-348, which has a precondition of its own. */}

        {/* Port config */}
        <FieldRow label="Port">
          <TextField
            size="small"
            type="number"
            value={portInput}
            onChange={handlePortChange}
            onBlur={handlePortBlur}
            onKeyDown={handlePortKeyDown}
            error={portError}
            helperText={portError ? '1-65535' : undefined}
            slotProps={{ htmlInput: { min: 1, max: 65535 } }}
            sx={{ width: 110, '& input': { fontFamily: 'monospace', fontSize: 13 } }}
          />
        </FieldRow>

        {/* Server controls — the enable toggle above starts/stops the connection;
            these steer the bridge server itself. */}
        {mcp.connected && (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Button size="small" variant="outlined" onClick={() => mcpPlugin?.pauseServer()}
              sx={{ textTransform: 'none' }}>Pause</Button>
            <Button size="small" variant="outlined" onClick={() => mcpPlugin?.resumeServer()}
              sx={{ textTransform: 'none' }}>Resume</Button>
            <Button size="small" variant="outlined" color="error" onClick={() => mcpPlugin?.shutdownServer()}
              sx={{ textTransform: 'none' }}>Shutdown</Button>
          </Box>
        )}
      </SettingsSection>

      {/* CONNECT RAG / LLM status — the AI-diagnosis assistant that lives in realvirtual CONNECT,
          shown here next to the MCP bridge (plan-284). Independent of the MCP connection. */}
      <RagStatusSection />

      {/* Setup helper — shown until the bridge is connected. */}
      {!mcp.connected && (
        <SettingsSection id="mcp-setup" title="Setup — enable the AI Bridge">
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.65)' }}>
            realvirtual CONNECT hosts the AI Bridge itself — no Node, no extra install.
          </Typography>
          {/* Dead end without a gateway: mobile reaches this tab directly and never
              sees the activity-bar download dialog, so the same affordance sits here. */}
          <ConnectDownloadLinks />
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 0.5 }}>
            <SetupStep n={1} title="Run CONNECT with the MCP server enabled">
              <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.65)' }}>
                Tray icon ▸ <b>MCP server ▸ Enabled</b> (takes effect after a CONNECT restart).
              </Typography>
            </SetupStep>
            <SetupStep n={2} title="Register CONNECT with Claude Code">
              <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.65)' }}>
                Add this to your <code>.mcp.json</code>. Claude Desktop (classic) has no native
                HTTP client — start it through <code>npx -y mcp-remote http://localhost:5100/mcp
                --allow-http</code> instead.
              </Typography>
              <CodeBlock text={CONNECT_MCP_SNIPPET} />
            </SetupStep>
            <SetupStep n={3} title="Restart Claude, then turn AI control on (toggle above)">
              <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.65)' }}>
                Leave the port at <code>5100</code> — that is CONNECT. Running against the Vite dev
                server works too: open it with <code>?mcpPort=5100</code>, or just leave the
                default. On a hosted page (web.realvirtual.io) the bridge connects to localhost
                automatically; confirm once in the tray.
              </Typography>
            </SetupStep>
            <SetupStep n={4} title="Fallback only — the local Node bridge">
              <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.65)' }}>
                Use this if CONNECT is unavailable. Build it once, register it, then set the port
                above to <code>18714</code> (Claude Desktop) or <code>18715</code> (Claude Code).
              </Typography>
              <CodeBlock text={BUILD_CMD} />
              <CodeBlock text={NODE_FALLBACK_SNIPPET} />
            </SetupStep>
          </Box>
        </SettingsSection>
      )}

      {/* Tool list */}
      {mcp.toolNames.length > 0 && (
        <SettingsSection id="mcp-tools" title={`Registered Tools (${mcp.toolNames.length})`}>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, pl: 1 }}>
            {mcp.toolNames.map(name => (
              <Typography key={name} variant="caption"
                sx={{ fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>
                {name}
              </Typography>
            ))}
          </Box>
        </SettingsSection>
      )}

      {/* Server log — streamed from the bridge server over the WebSocket. */}
      {log.length > 0 && (
        <SettingsSection id="mcp-server-log" title={`Server Log (${log.length})`}>
          <Box sx={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0.1, pl: 0.5 }}>
            {log.slice(-100).map((line, i) => (
              <Typography key={i} variant="caption"
                sx={{ fontFamily: 'monospace', fontSize: 10.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  color: line.level === 'error' ? '#ef5350' : line.level === 'warn' ? '#ffa726' : 'rgba(255,255,255,0.6)' }}>
                {line.msg}
              </Typography>
            ))}
          </Box>
        </SettingsSection>
      )}
    </Box>
  );
}
