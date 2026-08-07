// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ConnectPanel — LeftPanel for realvirtual CONNECT gateway configuration.
 *
 * Sections:
 *   1. Server URL input + Connect/Disconnect + status indicator
 *   2. Interface list (accordion per interface, online/offline, signal count)
 *   3. Add Interface dialog
 *   4. Signal Browser table (discovery results with checkboxes)
 *   5. Bind Selected action
 */

import { useState, useSyncExternalStore, useCallback, useRef, useMemo, useEffect, type ReactNode } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Button,
  TextField,
  Divider,
  Chip,
  Checkbox,
  Collapse,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  MenuItem,
  Menu,
  Select,
  FormControl,
  InputLabel,
  CircularProgress,
  InputAdornment,
  Tooltip,
  FormControlLabel,
  Snackbar,
  Alert,
  Badge,
  Popover,
  ToggleButton,
  ToggleButtonGroup,
  Switch,
} from '@mui/material';
import {
  Cable,
  Delete,
  Edit,
  ExpandMore,
  ExpandLess,
  Search,
  Add,
  Close,
  Circle,
  SelectAll,
  Deselect,
  Upload,
  Article,
  PlayArrow,
  Pause,
  ClearAll,
  FilterList,
  ContentCopy,
  Check,
  SwapHoriz,
  MoreVert,
  Settings,
  PowerSettingsNew,
  FiberManualRecord,
  StopCircle,
} from '@mui/icons-material';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useViewer } from '../../hooks/use-viewer';
import { LeftPanel } from './LeftPanel';
import { FloatingPanel } from './FloatingPanel';
import {
  CONNECT_PANEL_MIN_WIDTH,
  CONNECT_PANEL_MAX_WIDTH,
  LS_KEY_CONNECT_PANEL_WIDTH,
  getStoredConnectPanelWidth,
} from './layout-constants';
import { RV_SCROLL_CLASS } from './shared-sx';
import {
  subscribeConnectStore,
  getConnectSnapshot,
  setActiveInterface,
  startDiscovery,
  updateInterface,
  toggleSignalSelection,
  selectAllSignals,
  bindSelectedSignals,
  discoveredSignalName,
  removeInterface,
  addInterface,
  importTagTable,
  importMultiTabTagTable,
  importS7TagTable,
  fetchInterfaces,
  fetchLogs,
  fetchStatus,
  fetchMirrors,
  putMirrors,
  fetchMappings,
  putMappings,
  fetchProfiles,
  saveProfile,
  updateProfile,
  deleteProfile,
  activateProfile,
  fetchActiveModel,
  nextInterfaceId,
  removeSignal,
  getSignalSchema,
  CONNECT_INTERFACE_TYPES,
  getAvailableInterfaceTypes,
  TWINCAT_SETTINGS_DEFAULTS,
  MODBUS_SETTINGS_DEFAULTS,
  MODBUS_SERVER_SETTINGS_DEFAULTS,
  ETHERNETIP_SETTINGS_DEFAULTS,
  CTRLX_SETTINGS_DEFAULTS,
  CTRLXDATALAYER_SETTINGS_DEFAULTS,
  KEBA_SETTINGS_DEFAULTS,
  FESTO_SETTINGS_DEFAULTS,
  FANUC_SETTINGS_DEFAULTS,
  DENSO_SETTINGS_DEFAULTS,
  ABB_ROBOTSTUDIO_SETTINGS_DEFAULTS,
  humanizeConnectError,
  humanizeConnectWorkerStatus,
  type ConnectInterface,
  type ConnectInterfaceSignal,
  type ConnectInterfaceType,
  type ConnectInterfaceTypeDef,
  type ConnectLogEntry,
  type ConnectMirrorRule,
  type ConnectSignalMapping,
  type ConnectProfileInfo,
  type ConnectState,
  type TwinCatSettings,
  type TwinCatUpdateMode,
  type ModbusSettings,
  type ModbusWordOrder,
  type ModbusTransport,
  type EthernetIpSettings,
  type EipPlcType,
  type CtrlXSettings,
  type CtrlXDataLayerSettings,
  type KebaSettings,
  type FestoSettings,
  type FanucSettings,
  type DensoSettings,
  type DensoControllerType,
  type AbbRobotStudioSettings,
  type ConnectSignalIssue,
} from './connect-store';
import {
  parseTagTable,
  readWorkbookSheets,
  buildTopicsFromRows,
  type ParsedTagTable,
  type ParsedMultiTabTable,
} from '../import/s7-tag-table';
import { ISA_GREEN, ISA_RED, ISA_AMBER, connectionStateColor } from './isa-colors';
import { SignalBadge } from './rv-signal-badge';
import { middleTruncate } from './rv-middle-truncate';
import { SignalEditDialog } from './SignalEditDialog';
import {
  buildTopicTree,
  flattenTopicTree,
  ancestorPathsOf,
  type TopicTreeEntry,
} from './build-topic-tree';
import { armSignalDrag, consumeSignalDragClick } from './signal-drag-store';
import {
  applySelection,
  groupKeysByTopic,
  pruneSelection,
  selectionIntent,
  selectionKey,
} from './signal-selection';
import { navigateToRef } from './rv-reference-display';
import { getViewerMode, isSourceConnectedLive } from './connect-store';
import { historianStore } from './historian-store';
import {
  type SignalActivity,
  activityOpacity,
  activityStatusMarker,
  activityStatusHint,
} from '../engine/rv-signal-activity';
import {
  type SignalFilterState,
  type SignalBindingKind,
  type PlcTypeKind,
  emptySignalFilterState,
  matchesSignalFilter,
  plcTypeKind,
  activeFilterCount,
  isSignalFilterActive,
  filterNeedsActivity,
} from './signal-list-filter';
import { useSignalActivityIndicator, setSignalActivityIndicator } from './signal-activity-indicator-store';
import { useThrottledSignalValue } from '../../hooks/use-throttled-signal';
import { useSignalActivityValue } from '../../hooks/use-signal-activity';
import { WarningAmber, RemoveCircleOutline, Sensors, Link as LinkIcon, Hub, InfoOutlined, PrecisionManufacturing } from '@mui/icons-material';
import { memo } from 'react';
import {
  supportsFsAccess,
  saveLastFileHandle,
  getLastFileHandle,
  clearLastFileHandle,
  ensureReadPermission,
} from './import-file-handle-store';
import {
  loadInterfaceSettings,
  saveInterfaceSettings,
} from '../../interfaces/interface-settings-store';
import { getLicenseSnapshot, subscribeLicenseStore, deriveLicensePresentation, type LicenseStatus } from './license-store';
import { ConfirmActionDialog, type ConfirmAction } from './ConfirmActionDialog';
import { ConnectOptionsWindow } from './ConnectOptionsWindow';
import { ConnectUpdateNotice } from './ConnectUpdateNotice';
import { CONNECT_STABLE_DOWNLOAD_URL } from './connect-downloads';
import { useConnectDownloads } from './use-connect-downloads';
import { statusAge } from './connect-staleness';

// ── Signal-count helper (counts ProcessImage topic signals + legacy signals) ──

function interfaceSignalCount(iface: ConnectInterface): number {
  const topicCount = (iface.topics ?? []).reduce((sum, t) => sum + (t.signals?.length ?? 0), 0);
  return topicCount + (iface.signals?.length ?? 0);
}

/** Flatten all signals (topic + legacy) for an interface. */
function interfaceSignals(iface: ConnectInterface): ConnectInterfaceSignal[] {
  const topicSignals = (iface.topics ?? []).flatMap(t => t.signals ?? []);
  return [...topicSignals, ...(iface.signals ?? [])];
}

// ── Status helpers ─────────────────────────────────────────────────────

/**
 * Display state of the gateway connection. `unreachable` overrides a nominal
 * 'connected': the /status poll has been failing, so the panel must not keep
 * claiming a live link (status truthfulness — never a green lie).
 */
function statusDisplay(
  state: ConnectState,
  unreachable: boolean,
  gatewaySetupNeeded: boolean,
): { color: string; label: string; warn: boolean } {
  if (state === 'connected' && unreachable) {
    return { color: ISA_AMBER, label: 'Gateway unreachable', warn: true };
  }
  if (state === 'error' && gatewaySetupNeeded) {
    // Never-linked is the CONNECT acquisition moment, not a fault — neutral
    // status; amber stays reserved for a live link that broke (unreachable).
    return { color: 'rgba(255,255,255,0.5)', label: 'Not connected', warn: false };
  }
  switch (state) {
    case 'connected': return { color: connectionStateColor(state) ?? 'rgba(255,255,255,0.5)', label: 'Connected', warn: false };
    case 'connecting': return { color: connectionStateColor(state) ?? 'rgba(255,255,255,0.5)', label: 'Connecting...', warn: false };
    case 'error': return { color: connectionStateColor(state) ?? 'rgba(255,255,255,0.5)', label: 'Error', warn: true };
    default: return { color: 'rgba(255,255,255,0.5)', label: 'Disconnected', warn: false };
  }
}

/** Human-readable label for an interface type — gateway catalog first, static registry as fallback. */
function interfaceTypeLabel(type: ConnectInterfaceType): string {
  return getAvailableInterfaceTypes().find(d => d.type === type)?.label
    ?? CONNECT_INTERFACE_TYPES.find(d => d.type === type)?.label
    ?? type;
}

/** Dot color for a per-interface worker status (green = Connected, red = Error, amber = (re)connecting). */
export function interfaceDotColor(status: string | undefined, enabled: boolean): string {
  if (!enabled) return 'rgba(255,255,255,0.5)';
  switch (status) {
    case 'Connected': return ISA_GREEN;
    case 'Error': return ISA_RED;
    case 'Connecting':
    case 'Reconnecting':
    case 'SignalLimitExceeded': return ISA_AMBER;
    default: return 'rgba(255,255,255,0.5)'; // Stopped / not yet known
  }
}

/**
 * Short visible label for a non-nominal worker status. Abnormal states must be
 * readable as text, never as a color dot alone (ISA-101 / State-Is-Sacred).
 * Nominal 'Connected' stays a quiet dot (tooltip + aria-label carry the text).
 */
export function interfaceStatusShort(status: string | undefined, enabled: boolean): string | null {
  if (!enabled) return 'Disabled'; // enable/disable lives in the ⋮ menu — the row must say it
  switch (status) {
    case 'Error': return 'Error';
    case 'Connecting': return 'Connecting';
    case 'Reconnecting': return 'Reconnecting';
    case 'SignalLimitExceeded': return 'Signal limit';
    case 'Stopped': return 'Stopped';
    default: return null;
  }
}

const UNLIMITED_SIGNAL_LIMIT = 2_147_483_647;

export interface SignalBudgetPresentation {
  label: string | null;
  warning: boolean;
}

/** Derive the quiet interface-header budget without exposing the unlimited sentinel. */
export function signalBudgetPresentation(status: LicenseStatus | null): SignalBudgetPresentation | null {
  if (!status) return null;
  const showBudget = status.maxSignals > 0 && status.maxSignals < UNLIMITED_SIGNAL_LIMIT;
  if (!showBudget) return null;

  return {
    label: `Signals ${status.admittedSignals} / ${status.maxSignals}`,
    warning: status.admittedSignals / status.maxSignals >= 0.8,
  };
}

/** Preventive signal-budget summary for the Interfaces header. */
export function SignalBudgetIndicator({ status }: { status: LicenseStatus | null }) {
  const presentation = signalBudgetPresentation(status);
  if (!presentation) return null;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}>
      {presentation.label && (
        <Typography
          component="span"
          sx={{
            fontSize: 11,
            fontFamily: 'monospace',
            fontWeight: presentation.warning ? 600 : 400,
            color: presentation.warning ? ISA_AMBER : 'text.secondary',
          }}
        >
          {presentation.label}
        </Typography>
      )}
    </Box>
  );
}

/** Stable download label — brand text, enriched with the semantic version when the manifest
 *  is reachable. Falls back to the plain brand text (unchanged accessible name) otherwise. */
function stableDownloadLabel(version: string | null): string {
  return version
    ? `Download realvirtual CONNECT ${version}`
    : 'Download realvirtual CONNECT';
}

/** Human tooltip carrying the build number + date when known. */
function channelBuildTitle(build: number | null, buildDate: string | null): string | undefined {
  if (build == null && !buildDate) return undefined;
  const parts = [build != null ? `build ${build}` : null, buildDate].filter(Boolean);
  return parts.join(' · ');
}

/** Stable + beta download affordance reused in every connection dead end. Versions come from
 *  the published release manifests; the beta link appears ONLY when a beta build exists. */
export function ConnectDownloadLinks() {
  const downloads = useConnectDownloads();
  const { stable, beta } = downloads;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
      <Button
        component="a"
        href={stable.url}
        target="_blank"
        rel="noreferrer"
        size="small"
        variant="text"
        title={channelBuildTitle(stable.build, stable.buildDate)}
        sx={{ minWidth: 0, px: 0, fontSize: 10, textTransform: 'none' }}
      >
        {stableDownloadLabel(stable.version)}
      </Button>
      {beta && (
        <Button
          component="a"
          href={beta.url}
          target="_blank"
          rel="noreferrer"
          size="small"
          variant="text"
          title={channelBuildTitle(beta.build, beta.buildDate)}
          sx={{ minWidth: 0, p: 0, fontSize: 10, color: 'text.secondary', textTransform: 'none' }}
        >
          {beta.version ? `beta ${beta.version}` : 'beta'}
        </Button>
      )}
    </Box>
  );
}

// ── Acquisition opener ────────────────────────────────────────────────────
// Shown whenever no gateway has ever answered (disconnected, or a connect
// attempt found nothing at the URL). This state is the CONNECT funnel, not a
// fault: neutral status, download as the panel's one primary action, and the
// free space below states what CONNECT enables.

function OpenerCapability({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75 }}>
      <Box sx={{ color: 'rgba(255,255,255,0.7)', display: 'flex', mt: 0.1, flexShrink: 0 }}>{icon}</Box>
      <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.5 }}>
        <Box component="span" sx={{ fontWeight: 600, color: 'text.primary' }}>{title}</Box>
        {' — '}
        {text}
      </Typography>
    </Box>
  );
}

/** Opener content: value proposition + download as primary CTA + the quiet
 *  technical cause (only after a connect attempt actually failed). */
export function ConnectOpener({ failedUrl }: { failedUrl: string | null }) {
  const { stable, beta } = useConnectDownloads();
  return (
    <Box sx={{ mt: 0.75, color: 'text.secondary' }}>
      <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'text.primary', lineHeight: 1.5 }}>
        Live PLC data in this viewer
      </Typography>
      <Typography sx={{ fontSize: 11, lineHeight: 1.5, mt: 0.25 }}>
        realvirtual CONNECT is the local gateway that links this viewer to real
        controllers and robots. The free tier includes 20 PLC signals.
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mt: 1 }}>
        <Button
          component="a"
          href={stable.url}
          target="_blank"
          rel="noreferrer"
          size="small"
          variant="contained"
          title={channelBuildTitle(stable.build, stable.buildDate)}
          sx={{ fontSize: 11, textTransform: 'none', flexShrink: 0 }}
        >
          {stableDownloadLabel(stable.version)}
        </Button>
        {beta && (
          <Button
            component="a"
            href={beta.url}
            target="_blank"
            rel="noreferrer"
            size="small"
            variant="text"
            title={channelBuildTitle(beta.build, beta.buildDate)}
            sx={{ minWidth: 0, p: 0, fontSize: 10, color: 'text.secondary', textTransform: 'none' }}
          >
            {beta.version ? `beta ${beta.version}` : 'beta'}
          </Button>
        )}
      </Box>
      <Typography sx={{ fontSize: 11, lineHeight: 1.5, mt: 0.75 }}>
        Already installed? Start CONNECT on that machine, then press Connect.
      </Typography>
      {failedUrl && (
        <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', fontFamily: 'monospace', mt: 0.25 }}>
          no gateway at {failedUrl.replace(/^https?:\/\//, '')}
        </Typography>
      )}
      <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', my: 1 }} />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
        <OpenerCapability
          icon={<Sensors sx={{ fontSize: 14 }} />}
          title="Live signals"
          text="bind real PLC I/O to drives, sensors and HMI elements in this scene."
        />
        <OpenerCapability
          icon={<PrecisionManufacturing sx={{ fontSize: 14 }} />}
          title="Virtual commissioning"
          text="validate the real PLC program against the 3D machine, before or without the hardware."
        />
        <OpenerCapability
          icon={<Hub sx={{ fontSize: 14 }} />}
          title="Real controllers"
          text="S7, TwinCAT ADS, OPC UA, Modbus TCP, EtherNet/IP, ctrlX and MQTT, plus robot interfaces (FANUC, Denso, ABB)."
        />
      </Box>
    </Box>
  );
}

export function SignalLimitNotice({ signals, limit }: { signals: readonly string[]; limit?: number | null }) {
  const served = typeof limit === 'number' && limit > 0 && limit < 2_147_483_647
    ? `Only the first ${limit} signals are served`
    : 'Only the signals within the license limit are served';
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, px: 1, pb: 0.75 }}>
      <InfoOutlined aria-hidden sx={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', mt: 0.1, flexShrink: 0 }} />
      <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', lineHeight: 1.45 }}>
        {served} - {signals.length} more are configured. Activate a license to serve all signals.
      </Typography>
    </Box>
  );
}

/**
 * Per-signal gateway diagnostics (LOP #51/#52 hardening): the worker KNOWS these configured
 * signals can never receive a value (bad address, tag outside the received payload). Surfaced
 * as a compact amber badge on the interface card — the detail list opens on click, so the
 * one-line card stays one line. Previously this lived only in the gateway log.
 */
export function SignalIssueBadge({ issues }: { issues: readonly ConnectSignalIssue[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const MAX_SHOWN = 8;
  const shown = issues.slice(0, MAX_SHOWN);
  const summary = issues.length === 1
    ? '1 signal is configured but never receives values'
    : `${issues.length} signals are configured but never receive values`;
  return (
    <>
      <Tooltip title={`${summary} — click for details`}>
        <IconButton
          size="small"
          aria-label={summary}
          onClick={(e) => { e.stopPropagation(); setAnchor(e.currentTarget); }}
          sx={{ p: 0.25, flexShrink: 0, gap: 0.25, borderRadius: 1 }}
        >
          <WarningAmber sx={{ fontSize: 12, color: ISA_AMBER }} />
          <Typography component="span" sx={{ fontSize: 10, color: ISA_AMBER, lineHeight: 1 }}>
            {issues.length}
          </Typography>
        </IconButton>
      </Tooltip>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        onClick={(e) => e.stopPropagation()}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { p: 1, maxWidth: 340, bgcolor: 'rgba(30,30,30,0.85)', backdropFilter: 'blur(calc(16px * var(--rv-ui-blur-scale, 1)))', backgroundImage: 'none' } } }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
          <WarningAmber aria-hidden sx={{ fontSize: 13, color: ISA_AMBER, flexShrink: 0 }} />
          <Typography sx={{ fontSize: 10, color: ISA_AMBER, lineHeight: 1.45 }}>{summary}</Typography>
        </Box>
        {shown.map((iss, idx) => (
          <Typography
            key={`${iss.signal}-${idx}`}
            sx={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', lineHeight: 1.45, pl: 2.25 }}
          >
            <Box component="span" sx={{ fontFamily: 'monospace', color: 'rgba(255,255,255,0.75)' }}>
              {iss.topic ? `${iss.topic} · ` : ''}{iss.signal}
            </Box>
            {' — '}{iss.message}
          </Typography>
        ))}
        {issues.length > MAX_SHOWN && (
          <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', lineHeight: 1.45, pl: 2.25 }}>
            +{issues.length - MAX_SHOWN} more — see the gateway log for the full list.
          </Typography>
        )}
      </Popover>
    </>
  );
}

// ── Shared destructive-action confirmation ────────────────────────────────
// Lives in ConfirmActionDialog.tsx (shared with ConnectOptionsWindow).

// ── View-state persistence (survives browser reload) ──────────────────────
// Which interface is expanded, plus the per-interface signal filter and the
// collapsed topic groups. Keyed per interface where relevant.
const LS_CONNECT_EXPANDED = 'rv-connect-expanded-iface';
const LS_CONNECT_FILTER = 'rv-connect-filter';        // + ':' + iface.id
const LS_CONNECT_COLLAPSED = 'rv-connect-collapsed';  // + ':' + iface.id
const LS_CONNECT_SCROLL = 'rv-connect-scroll';        // + ':' + iface.id

/**
 * Shared empty array for the `overLimitSignals` prop (plan-344 Phase 3.3).
 * A `?? []` literal produces a NEW array on every ConnectPanel render, which
 * invalidated `useMemo(() => new Set(overLimitSignals))` inside SignalListView
 * every single time — and through it every memoised row. One frozen module-level
 * constant makes the "no signals over the limit" case referentially stable.
 */
const EMPTY_SIGNAL_NAMES: readonly string[] = Object.freeze([]);

function loadExpandedIface(): string | null {
  try { return localStorage.getItem(LS_CONNECT_EXPANDED) || null; } catch { return null; }
}
function saveExpandedIface(id: string | null): void {
  try {
    if (id) localStorage.setItem(LS_CONNECT_EXPANDED, id);
    else localStorage.removeItem(LS_CONNECT_EXPANDED);
  } catch { /* storage unavailable */ }
}
function loadSignalFilter(ifaceId: string): SignalFilterState {
  const base = emptySignalFilterState();
  try {
    const raw = localStorage.getItem(`${LS_CONNECT_FILTER}:${ifaceId}`);
    if (!raw) return base;
    const p = JSON.parse(raw) as Partial<SignalFilterState> & { types?: string[] };
    if (typeof p.text === 'string') base.text = p.text;
    if (p.active) base.active = p.active;
    if (p.connected) base.connected = p.connected;
    if (p.binding) base.binding = p.binding;
    if (p.recorded) base.recorded = p.recorded;
    if (Array.isArray(p.types)) for (const t of p.types) base.types.add(t as PlcTypeKind);
    return base;
  } catch { return base; }
}
function saveSignalFilter(ifaceId: string, f: SignalFilterState): void {
  try { localStorage.setItem(`${LS_CONNECT_FILTER}:${ifaceId}`, JSON.stringify({ ...f, types: [...f.types] })); } catch { /* storage unavailable */ }
}
/**
 * Collapse identities are TYPED (plan-352 §2.4): `topic:<name>` for a configured topic group,
 * `tree:<path>` for a derived MQTT topic-tree node. Without the prefix a topic literally named
 * `rv` and the tree node `rv` would share one collapse state.
 *
 * The PERSISTED form stays the legacy one — a bare topic name — so existing localStorage entries
 * keep working unchanged; only tree keys are written with their prefix. A stored key that is not a
 * tree key therefore always reads back as a topic key and can never collapse a tree node by
 * accident.
 */
const TREE_KEY_PREFIX = 'tree:';
const topicKey = (topic: string): string => `topic:${topic}`;
const treeKey = (path: string): string => `${TREE_KEY_PREFIX}${path}`;

function loadCollapsedGroups(ifaceId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${LS_CONNECT_COLLAPSED}:${ifaceId}`);
    const stored = raw ? JSON.parse(raw) as string[] : [];
    return new Set(stored.map(key => key.startsWith(TREE_KEY_PREFIX) ? key : topicKey(key)));
  } catch { return new Set(); }
}
function saveCollapsedGroups(ifaceId: string, s: Set<string>): void {
  const stored = [...s].map(key => key.startsWith(TREE_KEY_PREFIX) ? key : key.replace(/^topic:/, ''));
  try { localStorage.setItem(`${LS_CONNECT_COLLAPSED}:${ifaceId}`, JSON.stringify(stored)); } catch { /* storage unavailable */ }
}
// Scroll offset of the virtualized signal list, one value per interface
// (plan-344 Phase 3.4). Closing the panel returns `null` from ConnectPanel, which
// unmounts SignalListView together with its scroll container — filter and
// collapsed groups survive because they are persisted, the scroll position did
// not. Deliberately NOT a general scroll-restore mechanism: one number per
// interface, written on scroll and restored on mount.
function loadSignalScroll(ifaceId: string): number {
  try {
    const raw = localStorage.getItem(`${LS_CONNECT_SCROLL}:${ifaceId}`);
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}
function saveSignalScroll(ifaceId: string, offset: number): void {
  try {
    if (offset > 0) localStorage.setItem(`${LS_CONNECT_SCROLL}:${ifaceId}`, String(Math.round(offset)));
    else localStorage.removeItem(`${LS_CONNECT_SCROLL}:${ifaceId}`);
  } catch { /* storage unavailable */ }
}

// ── ConnectPanel ───────────────────────────────────────────────────────

export function ConnectPanel() {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  const panelSnap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const licenseSnap = useSyncExternalStore(subscribeLicenseStore, getLicenseSnapshot);
  // Historian status is polled by the trend-plugin toolbar button while
  // connected; the panel only reads it (recording-fault line + gear badge).
  const historianSnap = useSyncExternalStore(historianStore.subscribe, historianStore.getSnapshot, historianStore.getSnapshot);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [editIface, setEditIface] = useState<ConnectInterface | null>(null);
  const [expandedIface, setExpandedIface] = useState<string | null>(loadExpandedIface);
  const [importOpen, setImportOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  // Bridges (mirror rules + 1:1 signal mappings) — null while unloaded / unsupported gateway.
  const bridges = useBridges(snap.state === 'connected');
  // Open the Add-Mapping dialog; a string pre-fills the source signal (signal-row bridge action).
  const [mappingDialog, setMappingDialog] = useState<{ sourceSignal: string } | null>(null);
  // Pending destructive action awaiting confirmation (interface delete).
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  // Persist which interface is expanded so it survives a browser reload.
  useEffect(() => { saveExpandedIface(expandedIface); }, [expandedIface]);

  const isOpen = panelSnap.activePanel === 'connect';

  // Resizable width (hierarchy-browser convention): persisted across sessions and mirrored into
  // the LeftPanelManager so the viewport/ButtonPanel offset follows the dragged edge live.
  const [panelWidth, setPanelWidth] = useState<number>(() => getStoredConnectPanelWidth());
  const handleResize = useCallback((w: number) => {
    setPanelWidth(w);
    try { localStorage.setItem(LS_KEY_CONNECT_PANEL_WIDTH, String(w)); } catch { /* storage unavailable */ }
    lpm.open('connect', w); // same id → just updates the registered width / viewport shift
  }, [lpm]);

  const handleClose = useCallback(() => {
    lpm.close('connect');
  }, [lpm]);

  const handleBrowse = useCallback(async (ifaceId: string) => {
    setActiveInterface(ifaceId);
    await startDiscovery(ifaceId);
  }, []);

  // Interface delete is unrecoverable (it removes the whole signal configuration
  // from the gateway), so it always confirms — naming the interface and payload.
  const handleRemoveInterface = useCallback((iface: ConnectInterface) => {
    const count = interfaceSignalCount(iface);
    setConfirmAction({
      title: `Delete interface '${iface.id}'?`,
      message: `Removes the ${interfaceTypeLabel(iface.type)} interface${count > 0 ? ` and its ${count} signal${count === 1 ? '' : 's'}` : ''} from the gateway configuration. This can't be undone.`,
      confirmLabel: 'Delete interface',
      onConfirm: () => removeInterface(iface.id),
    });
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIface(prev => prev === id ? null : id);
  }, []);

  const handleOpenImport = useCallback((targetId: string | null) => {
    setImportTarget(targetId);
    setImportOpen(true);
  }, []);

  // Enable/disable an interface directly from its card. A disabled interface
  // starts no worker (no broker/PLC connection, no signals), so this toggle is
  // what turns live data on or off per interface.
  const handleSetEnabled = useCallback((id: string, enabled: boolean) => {
    void updateInterface(id, { enabled }).catch((err) => {
      console.error('[ConnectPanel] Failed to toggle interface enabled:', err);
    });
  }, []);

  /**
   * One-click mirror (plan-257): bridge ALL signals of `iface` into a sink of `targetType`.
   * Reuses an existing sink interface of that type when present, otherwise creates one with the
   * gateway catalog's defaults, then appends a `*` mirror rule. Direction-preserving.
   */
  const handleOneClickMirror = useCallback(async (iface: ConnectInterface, targetType: 'MQTT' | 'SHM') => {
    try {
      let target = snap.interfaces.find(i => i.type === targetType && i.id !== iface.id);
      if (!target) {
        const defaults = getAvailableInterfaceTypes().find(t => t.type === targetType)?.defaults
          ?? CONNECT_INTERFACE_TYPES.find(t => t.type === targetType)?.defaults
          ?? {};
        target = await addInterface({
          id: nextInterfaceId(targetType),
          type: targetType,
          enabled: true,
          ...defaults,
        } as Omit<ConnectInterface, 'id' | 'signals'> & { id?: string });
      }
      const current = bridges.mirrors ?? (await fetchMirrors());
      if (current.some(m => m.sourceInterfaceId === iface.id && m.targetInterfaceId === target!.id)) {
        bridges.setError(`Mirror ${iface.id} → ${target.id} already exists.`);
        return;
      }
      await bridges.saveMirrors([...current, {
        enabled: true,
        sourceInterfaceId: iface.id,
        targetInterfaceId: target.id,
        signalPattern: '*',
        topicPrefix: '',
      }]);
    } catch (err) {
      bridges.setError(err instanceof Error ? err.message : 'Failed to create mirror.');
    }
  }, [snap.interfaces, bridges]);

  // Stable bridge-dialog opener (plan-344 Phase 3.3). Inline as
  // `(name) => setMappingDialog(...)` this got a fresh identity on every
  // ConnectPanel render, which propagated down as a changed `onBridge` prop and
  // made `React.memo` fail for EVERY visible signal row.
  const handleBridgeSignalByName = useCallback(
    (name: string) => setMappingDialog({ sourceSignal: name }),
    [],
  );

  // Poll per-interface worker status while connected — drives the green/red status dots.
  // Gated on `isOpen` as well (plan-344 Phase 3.4): ConnectPanel stays MOUNTED
  // when closed (App.tsx renders it permanently; the `null` return below sits
  // after all hooks) so the user's panel state survives, but a closed panel must
  // not keep polling the gateway — nothing it produces is visible.
  useEffect(() => {
    if (!isOpen || snap.state !== 'connected') return;
    fetchStatus();
    const id = setInterval(fetchStatus, 2000);
    return () => clearInterval(id);
  }, [isOpen, snap.state]);

  // While the gateway is unreachable no store updates arrive, so tick locally
  // every second to keep the "last response Xs ago" age counting up. Same
  // `isOpen` gate: the age line is not on screen while the panel is closed.
  const unreachable = snap.state === 'connected' && snap.gatewayUnreachable;
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    if (!isOpen || !unreachable) return;
    const id = window.setInterval(() => setAgeTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [isOpen, unreachable]);

  if (!isOpen) return null;

  const isConnected = snap.state === 'connected';
  const gatewaySetupNeeded = snap.state === 'error'
    && snap.errorMessage.startsWith('No gateway answered at ');
  // No gateway has ever answered — show the acquisition opener instead of an
  // error: this is the CONNECT funnel surface (download + what it enables).
  const showOpener = snap.state === 'disconnected' || gatewaySetupNeeded;
  const status = statusDisplay(snap.state, unreachable, gatewaySetupNeeded);

  // Settings-gear problem badge: red on ANY problem behind the gear — license
  // missing/degraded/pending, or historian enabled but not actually recording
  // (that is silent data loss, a genuine operational fault, so red is earned).
  const licPresentation = licenseSnap.status ? deriveLicensePresentation(licenseSnap.status) : null;
  const licenseAttention = licPresentation?.kind === 'warning' || licPresentation?.kind === 'pending';
  const historianProblem = isConnected
    && historianSnap.status?.enabled === true
    && !historianSnap.status.connected;
  const settingsProblem = licenseAttention || historianProblem;
  const settingsProblemHint = [
    licenseAttention ? 'license needs attention' : null,
    historianProblem ? 'historian not recording' : null,
  ].filter(Boolean).join(', ');

  return (
    <LeftPanel
      title={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Cable sx={{ fontSize: 16, color: 'primary.main' }} />
          <Typography variant="subtitle2" sx={{ fontSize: '0.8rem', fontWeight: 600, color: 'text.primary' }}>
            realvirtual CONNECT
          </Typography>
        </Box>
      }
      onClose={handleClose}
      width={panelWidth}
      resizable
      minWidth={CONNECT_PANEL_MIN_WIDTH}
      maxWidth={CONNECT_PANEL_MAX_WIDTH}
      onResize={handleResize}
      footer={isConnected ? (
        <Button
          size="small"
          fullWidth
          variant="text"
          startIcon={<Article sx={{ fontSize: 14 }} />}
          onClick={() => setLogOpen(true)}
          sx={{ fontSize: 11, textTransform: 'none', py: 0.5, color: 'text.secondary' }}
        >
          Log
        </Button>
      ) : undefined}
    >
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {/* ── Section 1: Status line (operations view) ──
            Connection setup, license, profiles and historian live in the
            CONNECT Settings floating window behind the gear. The tab shows
            one read-only status line: state · server, gear on the right. */}
        <Box sx={{ p: 1, flexShrink: 0 }}>
          {/* Status line — icon + label (never color alone) left, settings gear right.
              The last-response age appears only when it carries information (gateway lost). */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25, minWidth: 0 }}>
            {status.warn
              ? <WarningAmber sx={{ fontSize: 12, color: status.color, flexShrink: 0 }} />
              : <Circle sx={{ fontSize: 7, color: status.color, flexShrink: 0 }} />}
            <Typography sx={{ fontSize: 11, fontWeight: 500, color: status.color, flexShrink: 0 }}>
              {status.label}
            </Typography>
            {isConnected && (
              <Typography
                title={snap.serverUrl}
                sx={{
                  fontSize: 10, color: 'text.secondary', fontFamily: 'monospace',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                }}
              >
                · {snap.serverUrl.replace(/^https?:\/\//, '')}
              </Typography>
            )}
            {unreachable && snap.lastStatusUpdate > 0 && (
              <Typography sx={{ fontSize: 10, color: status.color, fontFamily: 'monospace', flexShrink: 0 }}>
                · last response {statusAge(snap.lastStatusUpdate, Date.now())} ago
              </Typography>
            )}
            <Box sx={{ flex: 1 }} />
            {!isConnected && snap.state !== 'connecting' && (
              <Button
                size="small"
                // In the opener the panel's one primary action is Download —
                // Connect steps back to outlined until a gateway exists.
                variant={showOpener ? 'outlined' : 'contained'}
                onClick={() => setOptionsOpen(true)}
                sx={{ fontSize: 10, textTransform: 'none', flexShrink: 0 }}
              >
                Connect...
              </Button>
            )}
            <Tooltip title={settingsProblem
              ? `CONNECT settings — ${settingsProblemHint}`
              : 'CONNECT settings — connection, license, profiles, historian'}
            >
              <IconButton
                size="small"
                aria-label={settingsProblem ? `CONNECT settings (${settingsProblemHint})` : 'CONNECT settings'}
                onClick={() => setOptionsOpen(true)}
                sx={{ color: 'rgba(255,255,255,0.6)', flexShrink: 0, p: 0.4 }}
              >
                <Badge
                  variant="dot"
                  color="error"
                  invisible={!settingsProblem}
                  sx={{ '& .MuiBadge-badge': { minWidth: 6, height: 6 } }}
                >
                  <Settings sx={{ fontSize: 15 }} />
                </Badge>
              </IconButton>
            </Tooltip>
          </Box>
          {/* Active configuration profile — operational truth (a model binding can
              swap it server-side), so it shows in the tab; switching profiles
              lives in the CONNECT Settings window behind the gear. */}
          {isConnected && !unreachable && snap.activeProfile && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25, minWidth: 0 }}>
              <Typography sx={{ fontSize: 10, color: 'text.secondary', flexShrink: 0 }}>
                Profile
              </Typography>
              <Tooltip
                title={`Active configuration profile${snap.activeProfileModel
                  ? ` — bound to model ${snap.activeProfileModel}` : ''}. Switch profiles in CONNECT settings.`}
              >
                <Typography
                  onClick={() => setOptionsOpen(true)}
                  sx={{
                    fontSize: 10, fontFamily: 'monospace', color: 'text.primary',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                    cursor: 'pointer', '&:hover': { textDecoration: 'underline' },
                  }}
                >
                  {snap.activeProfile}{snap.activeProfileModel ? ` · model: ${snap.activeProfileModel}` : ''}
                </Typography>
              </Tooltip>
            </Box>
          )}
          {/* A newer CONNECT exists (plan-363 Phase 8). Free of charge: it compares the /health the
              panel already fetched against the release manifest the download links already probed,
              and renders nothing at all when the installation is current. */}
          {isConnected && !unreachable && (
            <ConnectUpdateNotice onOpenSettings={() => setOptionsOpen(true)} />
          )}
          {/* Historian fault line — recording is enabled but nothing is being
              written (silent data loss). Operational truth, so it lives in the
              tab, not only inside the settings window. */}
          {historianProblem && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25, minWidth: 0 }}>
              <FiberManualRecord sx={{ fontSize: 10, color: ISA_RED, flexShrink: 0 }} />
              <Typography sx={{ fontSize: 10, color: ISA_RED, lineHeight: 1.4, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={historianSnap.status?.authError
                  ? 'Historian not recording - auth error, check the InfluxDB token'
                  : `Historian not recording - ${historianSnap.status?.disabledReason ?? 'InfluxDB unreachable'}`}
              >
                Historian not recording - {historianSnap.status?.authError
                  ? 'auth error, check token'
                  : historianSnap.status?.disabledReason ?? 'InfluxDB unreachable'}
              </Typography>
              <Button
                size="small"
                variant="text"
                onClick={() => setOptionsOpen(true)}
                sx={{ minWidth: 0, p: 0, fontSize: 10, textTransform: 'none', flexShrink: 0 }}
              >
                Fix...
              </Button>
            </Box>
          )}
          {unreachable && (
            <Box sx={{ mt: 0.25 }}>
              <Typography sx={{ fontSize: 10, color: 'text.secondary', lineHeight: 1.5 }}>
                The CONNECT gateway stopped responding - interface states are unknown.
                Reconnects automatically as soon as it is back.
              </Typography>
              <ConnectDownloadLinks />
            </Box>
          )}
          {snap.errorMessage && !gatewaySetupNeeded && (
            <Box sx={{ mt: 0.25 }}>
              <Typography sx={{ fontSize: 11, color: ISA_RED, lineHeight: 1.5 }}>
                {snap.errorMessage}
              </Typography>
              <ConnectDownloadLinks />
            </Box>
          )}
          {showOpener && (
            <ConnectOpener failedUrl={gatewaySetupNeeded ? snap.serverUrl : null} />
          )}
        </Box>

        <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />

        {/* ── Section 2: Interface List ── */}
        {isConnected && (
          <Box sx={{ p: 1, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5, flexShrink: 0 }}>
              <Typography sx={{ fontSize: 11, color: 'text.secondary', flex: 1 }}>
                Interfaces ({snap.interfaces.length})
              </Typography>
              <SignalBudgetIndicator status={licenseSnap.status} />
            </Box>

            {snap.interfaces.length === 0 && (
              <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', textAlign: 'center', py: 2 }}>
                No interfaces yet — Add one to link a PLC, robot or broker.
              </Typography>
            )}

            <Box
              className={RV_SCROLL_CLASS}
              sx={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}
            >
              {snap.interfaces.map((iface) => {
                const expanded = expandedIface === iface.id;
                // Also shown when empty but manually addable — otherwise a fresh S7/Modbus/…
                // interface (no discovery, no import yet) would have no way to add its first signal.
                const showSignals = expanded
                  && (interfaceSignalCount(iface) > 0 || !!getSignalSchema(iface.type)?.supportsManualAdd);
                return (
                  <Box
                    key={iface.id}
                    // Expanded interfaces size to their signal content instead of greedily
                    // claiming all free height (flex:1 painted a huge dead zone below two
                    // signals and shoved the sibling cards + Add button to the very bottom).
                    // maxHeight caps long lists so they scroll internally while the other
                    // cards stay visible right below; overflow:hidden is load-bearing so
                    // the capped content clips instead of painting over following cards.
                    sx={showSignals
                      ? {
                        flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
                        maxHeight: 'max(220px, calc(100vh - 340px))',
                      }
                      : { flexShrink: 0 }}
                  >
                    <Box sx={{ flexShrink: 0 }}>
                      <InterfaceCard
                        iface={iface}
                        status={unreachable ? undefined : snap.interfaceStatus[iface.id]?.status}
                        statusError={unreachable
                          ? 'Gateway unreachable — worker status unknown'
                          : snap.interfaceStatus[iface.id]?.error}
                        signalIssues={unreachable ? undefined : snap.interfaceStatus[iface.id]?.signalIssues}
                        overLimitSignals={licenseSnap.status?.overLimitSignals ?? EMPTY_SIGNAL_NAMES}
                        licenseLimit={licenseSnap.status?.maxSignals ?? null}
                        expanded={expanded}
                        onToggle={() => toggleExpand(iface.id)}
                        onSetEnabled={(en) => handleSetEnabled(iface.id, en)}
                        onBrowse={() => handleBrowse(iface.id)}
                        onImport={() => handleOpenImport(iface.id)}
                        onEdit={() => setEditIface(iface)}
                        onDelete={() => handleRemoveInterface(iface)}
                        onMirror={bridges.supported ? (t) => void handleOneClickMirror(iface, t) : undefined}
                      />
                    </Box>
                    {/* Signals shown inline whenever the interface is expanded — tree grows to fill space */}
                    {showSignals && (
                      <SignalListView
                        iface={iface}
                        overLimitSignals={licenseSnap.status?.overLimitSignals ?? EMPTY_SIGNAL_NAMES}
                        onBridgeSignal={bridges.supported ? handleBridgeSignalByName : undefined}
                      />
                    )}
                    {/* Older gateways without a signal schema: expanding an empty interface
                        must still say something instead of toggling nothing visible. */}
                    {expanded && !showSignals && (
                      <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', px: 1, py: 1 }}>
                        No signals yet — use the ⋮ menu to Browse or Import.
                      </Typography>
                    )}
                  </Box>
                );
              })}

              {/* Add Interface — the one primary action of this section, centered below the list. */}
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 1, flexShrink: 0 }}>
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<Add sx={{ fontSize: 14 }} />}
                  onClick={() => setAddDialogOpen(true)}
                  sx={{ fontSize: 11, textTransform: 'none' }}
                >
                  Add Interface
                </Button>
              </Box>
            </Box>

            {/* ── Bridges (mirrors & 1:1 mappings, plan-257) ── */}
            {bridges.supported && (
              <BridgeSection
                interfaces={snap.interfaces}
                bridges={bridges}
                onAddMapping={() => setMappingDialog({ sourceSignal: '' })}
              />
            )}
          </Box>
        )}

      </Box>

      {/* ── Add Mapping (signal bridge) Dialog ── */}
      {mappingDialog && (
        <AddMappingDialog
          open
          sourceSignal={mappingDialog.sourceSignal}
          interfaces={snap.interfaces}
          bridges={bridges}
          onClose={() => setMappingDialog(null)}
        />
      )}

      {/* ── Add Interface Dialog ── */}
      <AddInterfaceDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onCreated={(created) => {
          // Visible continuation: expand the fresh card and open Edit right away,
          // so adding never ends in a silent "nothing happened".
          setExpandedIface(created.id);
          setEditIface(created);
        }}
      />

      {/* ── Destructive-action confirmation (interface delete) ── */}
      <ConfirmActionDialog action={confirmAction} onClose={() => setConfirmAction(null)} />

      {/* ── Edit Interface Dialog ── */}
      {editIface && (
        <EditInterfaceDialog
          iface={editIface}
          open={!!editIface}
          onClose={() => setEditIface(null)}
        />
      )}

      {/* ── Import S7 Tag Table Dialog ── */}
      <ImportTagTableDialog
        open={importOpen}
        interfaces={snap.interfaces}
        initialTargetId={importTarget}
        onClose={() => setImportOpen(false)}
      />

      {/* ── CONNECT Settings (connection, license, profiles, historian) ── */}
      <ConnectOptionsWindow
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        onProfileSwitched={() => void bridges.reload()}
      />

      {/* ── Log Window ── */}
      <ConnectLogDialog open={logOpen} onClose={() => setLogOpen(false)} />

      {/* ── Browse Window (discovery + add to signals) ── */}
      <BrowseWindow open={!!snap.activeInterfaceId} onClose={() => setActiveInterface(null)} />
    </LeftPanel>
  );
}

// ── InterfaceCard ──────────────────────────────────────────────────────

function InterfaceCard({
  iface,
  status,
  statusError,
  signalIssues,
  overLimitSignals,
  licenseLimit,
  expanded,
  onToggle,
  onSetEnabled,
  onBrowse,
  onImport,
  onEdit,
  onDelete,
  onMirror,
}: {
  iface: ConnectInterface;
  status?: string;
  statusError?: string;
  /** Per-signal gateway diagnostics — signals that can never receive values (see SignalIssueBadge). */
  signalIssues?: readonly ConnectSignalIssue[];
  overLimitSignals: readonly string[];
  licenseLimit?: number | null;
  expanded: boolean;
  onToggle: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onBrowse: () => void;
  onImport: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** One-click mirror to a sink type (plan-257) — undefined hides the button (older gateway). */
  onMirror?: (targetType: 'MQTT' | 'SHM') => void;
}) {
  // All per-interface actions live in one "⋮" menu so the card stays a single line.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const closeMenu = useCallback(() => setMenuAnchor(null), []);
  // Count ProcessImage topic signals + legacy signals (R19 — otherwise always 0 for ProcessImage).
  const signalCount = interfaceSignalCount(iface);

  // Browse-button visibility: driven by the gateway's own signal schema (supportsDiscovery ⟺ the
  // worker implements IDiscoveryCapable). Older gateways without a schema fall back to the previous
  // hardcoded discovery-capable type list.
  const signalSchema = getSignalSchema(iface.type);
  const canBrowse = signalSchema
    ? signalSchema.supportsDiscovery
    : (iface.type === 'OpcUa' || iface.type === 'MQTT' || iface.type === 'TwinCat' || iface.type === 'EthernetIp' || iface.type === 'CtrlX' || iface.type === 'CtrlXDataLayer' || iface.type === 'Keba' || iface.type === 'Festo');

  // Extract display info based on interface type
  const getEndpointLabel = (): string => {
    if (iface.type === 'OpcUa') return (iface.endpoint as string) ?? '';
    if (iface.type === 'S7') return `${iface.ipAddress ?? ''} R:${iface.rack ?? 0} S:${iface.slot ?? 1}`;
    if (iface.type === 'MQTT') return (iface.brokerUrl as string) ?? '';
    if (iface.type === 'TwinCat') return iface.twinCat?.netId ?? '';
    if (iface.type === 'Modbus' || iface.type === 'ModbusServer') {
      return iface.modbus ? `${iface.modbus.host}:${iface.modbus.port}` : '';
    }
    if (iface.type === 'EthernetIp') return iface.ethernetIp?.gateway ?? '';
    if (iface.type === 'CtrlX') return iface.ctrlX?.address ?? '';
    if (iface.type === 'CtrlXDataLayer') return iface.ctrlXDataLayer?.address ?? '';
    if (iface.type === 'Keba') return iface.keba?.host ?? '';
    if (iface.type === 'Festo') return iface.festo ? `${iface.festo.host}:${iface.festo.port}` : '';
    if (iface.type === 'Fanuc') return iface.fanuc ? `${iface.fanuc.address}:${iface.fanuc.port}` : '';
    if (iface.type === 'Denso') return iface.denso ? `${iface.denso.host} (${iface.denso.controllerName})` : '';
    if (iface.type === 'AbbRobotStudio') return iface.abbRobotStudio?.sharedMemoryName ?? '';
    if (iface.type === 'SHM') return (iface.sharedMemory as { sharedMemoryName?: string })?.sharedMemoryName ?? '';
    return '';
  };

  const endpoint = getEndpointLabel();
  const statusText = status
    ? humanizeConnectWorkerStatus(status)
    : (iface.enabled ? 'Unknown' : 'Disabled');
  const statusErrorText = statusError ? humanizeConnectError(statusError) : undefined;
  const statusShort = interfaceStatusShort(status, iface.enabled);
  const dotColor = interfaceDotColor(status, iface.enabled);

  return (
    <Box sx={{ mb: 0.5, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.03)', overflow: 'hidden' }}>
      {/* Single-line card: status, type, id · endpoint (monospace), count, enable, actions menu.
          Everything else (Browse/Import/Edit/Mirror/Delete) lives in the "⋮" menu. */}
      <Box
        onClick={onToggle}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.5,
          cursor: 'pointer',
          '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
        }}
      >
        {expanded ? <ExpandLess sx={{ fontSize: 14 }} /> : <ExpandMore sx={{ fontSize: 14 }} />}
        <Tooltip title={`${statusText}${statusErrorText ? ` — ${statusErrorText}` : ''}`}>
          <Box
            component="span"
            role="img"
            aria-label={`Status: ${statusText}${statusErrorText ? ` — ${statusErrorText}` : ''}`}
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4, flexShrink: 0 }}
          >
            <Circle sx={{ fontSize: 7, color: dotColor }} />
            {/* Abnormal worker states get a visible text label — never color alone. */}
            {statusShort && (
              <Typography component="span" sx={{ fontSize: 10, color: dotColor, lineHeight: 1 }}>
                {statusShort}
              </Typography>
            )}
          </Box>
        </Tooltip>
        <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.primary', flexShrink: 0 }}>
          {iface.type}
        </Typography>
        {/* Identity: id + endpoint — two same-type interfaces must be tellable apart collapsed. */}
        <Tooltip title={`${iface.id}${endpoint && endpoint !== iface.id ? ` · ${endpoint}` : ''}`}>
          <Typography
            noWrap
            sx={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: 'monospace', flex: 1, minWidth: 0 }}
          >
            {iface.id}{endpoint && endpoint !== iface.id ? ` · ${endpoint}` : ''}
          </Typography>
        </Tooltip>
        {/* Always-visible amber badge: N configured signals can never decode (details on click). */}
        {!!signalIssues?.length && <SignalIssueBadge issues={signalIssues} />}
        <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: 'monospace', flexShrink: 0 }}>
          {signalCount}
        </Typography>
        <Tooltip title="Interface actions">
          <IconButton
            size="small"
            aria-label={`Actions for interface '${iface.id}'`}
            onClick={(e) => { e.stopPropagation(); setMenuAnchor(e.currentTarget); }}
            sx={{ p: 0.25, color: 'rgba(255,255,255,0.6)', flexShrink: 0 }}
          >
            <MoreVert sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Actions menu — one place for everything that is not the enable switch. */}
      {expanded && status === 'SignalLimitExceeded' && (
        <SignalLimitNotice signals={overLimitSignals} limit={licenseLimit} />
      )}

      <Menu
        anchorEl={menuAnchor}
        open={!!menuAnchor}
        onClose={closeMenu}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Enable/disable decides whether the worker connects and signals flow. */}
        <MenuItem sx={{ fontSize: 12, gap: 1 }} onClick={() => { closeMenu(); onSetEnabled(!iface.enabled); }}>
          <PowerSettingsNew sx={{ fontSize: 14, color: iface.enabled ? 'rgba(255,255,255,0.6)' : ISA_GREEN }} />
          {iface.enabled ? 'Disable' : 'Enable'}
        </MenuItem>
        <Divider />
        {canBrowse && (
          <MenuItem sx={{ fontSize: 12, gap: 1 }} onClick={() => { closeMenu(); onBrowse(); }}>
            <Search sx={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }} /> Browse signals…
          </MenuItem>
        )}
        {(iface.type === 'MQTT' || iface.type === 'S7') && (
          <MenuItem sx={{ fontSize: 12, gap: 1 }} onClick={() => { closeMenu(); onImport(); }}>
            <Upload sx={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }} /> Import tag table…
          </MenuItem>
        )}
        <MenuItem sx={{ fontSize: 12, gap: 1 }} onClick={() => { closeMenu(); onEdit(); }}>
          <Edit sx={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }} /> Edit…
        </MenuItem>
        {/* One-click bridge: mirror ALL signals of this interface into an MQTT/SHM sink,
            direction-preserving (out stays out, in stays in). Sinks don't offer it. */}
        {onMirror && iface.type !== 'MQTT' && iface.type !== 'SHM' && (
          <MenuItem sx={{ fontSize: 12, gap: 1 }} onClick={() => { closeMenu(); onMirror('MQTT'); }}>
            <SwapHoriz sx={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }} /> Mirror to MQTT
          </MenuItem>
        )}
        {onMirror && iface.type !== 'MQTT' && iface.type !== 'SHM' && (
          <MenuItem sx={{ fontSize: 12, gap: 1 }} onClick={() => { closeMenu(); onMirror('SHM'); }}>
            <SwapHoriz sx={{ fontSize: 14, color: 'rgba(255,255,255,0.6)' }} /> Mirror to SHM (shared memory)
          </MenuItem>
        )}
        <Divider />
        <MenuItem sx={{ fontSize: 12, gap: 1, color: ISA_RED }} onClick={() => { closeMenu(); onDelete(); }}>
          <Delete sx={{ fontSize: 14 }} /> Delete interface…
        </MenuItem>
      </Menu>

    </Box>
  );
}

// ── Add Interface Dialog ──────────────────────────────────────────────
//
// Instead of a type dropdown + form, the dialog lists every available interface
// type. The list comes from the CONNECTED GATEWAY's own `GET /interface-types`
// catalog (getAvailableInterfaceTypes) so it always matches what the running EXE
// can actually create — the static CONNECT_INTERFACE_TYPES registry is only the
// fallback for older gateways without the endpoint. Picking a row creates the
// interface immediately with minimal defaults (Enabled=false, a human-readable
// generated id) and hands the created interface to `onCreated`, which expands
// the fresh card and opens the Edit dialog for detail configuration — the Add
// flow always ends in a visible next step, never in silence.

function AddInterfaceDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the server-created interface so the parent can continue the flow (expand + Edit). */
  onCreated?: (iface: ConnectInterface) => void;
}) {
  const [creatingType, setCreatingType] = useState<ConnectInterfaceType | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handlePick = useCallback(async (def: ConnectInterfaceTypeDef) => {
    if (creatingType) return;
    setCreatingType(def.type);
    setError(null);
    try {
      const id = nextInterfaceId(def.type);
      const created = await addInterface({
        id,
        type: def.type,
        enabled: false,
        ...def.defaults,
      } as Omit<ConnectInterface, 'id' | 'signals'> & { id?: string });
      setCreatingType(null);
      onClose();
      onCreated?.(created);
    } catch (err) {
      setCreatingType(null);
      setError(err instanceof Error ? err.message : 'Failed to add interface.');
    }
  }, [creatingType, onClose, onCreated]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14 }}>
        <Add sx={{ color: 'primary.main' }} />
        Add Interface
      </DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        {error && (
          <Typography sx={{ fontSize: 11, color: ISA_RED, mb: 1 }}>{error}</Typography>
        )}
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {getAvailableInterfaceTypes().map((def) => {
            const isCreatingThis = creatingType === def.type;
            const disabled = !!creatingType && !isCreatingThis;
            return (
              <Box
                key={def.type}
                onClick={() => void handlePick(def)}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 1.25,
                  py: 1,
                  borderRadius: 1,
                  bgcolor: 'rgba(255,255,255,0.03)',
                  cursor: creatingType ? 'default' : 'pointer',
                  opacity: disabled ? 0.4 : 1,
                  transition: 'background-color 0.1s',
                  '&:hover': creatingType ? undefined : { bgcolor: 'rgba(79,195,247,0.08)' },
                }}
              >
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'text.primary' }}>
                    {def.label}
                  </Typography>
                  <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.65)' }}>
                    {def.description}
                  </Typography>
                </Box>
                {isCreatingThis && <CircularProgress size={14} />}
              </Box>
            );
          })}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Edit Interface Dialog ────────────────────────────────────────────

/** TwinCAT-specific fields (nested `twinCat` settings block). */
function TwinCatFieldsBlock({
  value,
  onChange,
}: {
  value: TwinCatSettings;
  onChange: (patch: Partial<TwinCatSettings>) => void;
}) {
  return (
    <>
      <TextField
        fullWidth size="small" label="AMS NetId" value={value.netId}
        onChange={(e) => onChange({ netId: e.target.value })}
        placeholder="5.78.123.1.1.1" sx={{ mb: 1 }}
      />
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" label="ADS Port" value={value.adsPort}
          onChange={(e) => onChange({ adsPort: parseInt(e.target.value, 10) || 0 })}
          sx={{ flex: 1 }}
        />
        <FormControl size="small" sx={{ flex: 1 }}>
          <InputLabel id="twincat-mode-label">Mode</InputLabel>
          <Select
            labelId="twincat-mode-label"
            label="Mode"
            value={value.mode}
            onChange={(e) => onChange({ mode: e.target.value as TwinCatUpdateMode })}
          >
            <MenuItem value="SumCommand">Sum Command</MenuItem>
            <MenuItem value="OnChange">On Change</MenuItem>
            <MenuItem value="Cyclic">Cyclic</MenuItem>
          </Select>
        </FormControl>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Checkbox size="small" checked={value.useEmbeddedRouter} onChange={(e) => onChange({ useEmbeddedRouter: e.target.checked })} />
        <Typography sx={{ fontSize: 12 }}>Use embedded AMS router</Typography>
      </Box>
      {value.useEmbeddedRouter && (
        <TextField
          fullWidth size="small" label="Router local NetId (optional)"
          value={value.routerLocalNetId ?? ''}
          onChange={(e) => onChange({ routerLocalNetId: e.target.value || null })}
          placeholder="127.0.0.1.1.1" sx={{ mb: 1 }}
        />
      )}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Checkbox size="small" checked={value.writeAllInputsOnStart} onChange={(e) => onChange({ writeAllInputsOnStart: e.target.checked })} />
        <Typography sx={{ fontSize: 12 }}>Write all inputs on start</Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Checkbox size="small" checked={value.readAllOutputsOnStart} onChange={(e) => onChange({ readAllOutputsOnStart: e.target.checked })} />
        <Typography sx={{ fontSize: 12 }}>Read all outputs on start</Typography>
      </Box>
      <TextField
        fullWidth size="small" label="Max sub-commands (Sum Command mode)"
        value={value.maxSubCommands}
        onChange={(e) => onChange({ maxSubCommands: parseInt(e.target.value, 10) || 0 })}
        sx={{ mb: 1 }}
      />
    </>
  );
}

/** Modbus-specific fields (nested `modbus` settings block) — shared by `Modbus` (client) and `ModbusServer`. */
function ModbusFieldsBlock({
  value,
  onChange,
  isServerMode,
}: {
  value: ModbusSettings;
  onChange: (patch: Partial<ModbusSettings>) => void;
  isServerMode: boolean;
}) {
  return (
    <>
      <TextField
        fullWidth size="small"
        label={isServerMode ? 'Bind Address (0.0.0.0 = all interfaces)' : 'Host'}
        value={value.host}
        onChange={(e) => onChange({ host: e.target.value })}
        placeholder={isServerMode ? '0.0.0.0' : '192.168.1.60'}
        sx={{ mb: 1 }}
      />
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" label="Port" value={value.port}
          onChange={(e) => onChange({ port: parseInt(e.target.value, 10) || 0 })}
          sx={{ flex: 1 }}
        />
        <TextField
          size="small" label="Unit Id" value={value.unitId}
          onChange={(e) => onChange({ unitId: parseInt(e.target.value, 10) || 0 })}
          sx={{ flex: 1 }}
        />
      </Box>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <FormControl size="small" sx={{ flex: 1 }}>
          <InputLabel id="modbus-wordorder-label">Word Order</InputLabel>
          <Select
            labelId="modbus-wordorder-label" label="Word Order"
            value={value.wordOrder}
            onChange={(e) => onChange({ wordOrder: e.target.value as ModbusWordOrder })}
          >
            <MenuItem value="ABCD">ABCD (big-endian)</MenuItem>
            <MenuItem value="CDAB">CDAB (word-swapped)</MenuItem>
            <MenuItem value="BADC">BADC (byte-swapped)</MenuItem>
            <MenuItem value="DCBA">DCBA (little-endian)</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ flex: 1 }}>
          <InputLabel id="modbus-transport-label">Transport</InputLabel>
          <Select
            labelId="modbus-transport-label" label="Transport"
            value={value.transport}
            onChange={(e) => onChange({ transport: e.target.value as ModbusTransport })}
          >
            <MenuItem value="Tcp">TCP</MenuItem>
            <MenuItem value="Rtu" disabled>RTU (not yet implemented)</MenuItem>
          </Select>
        </FormControl>
      </Box>
    </>
  );
}

/** EtherNet/IP-specific fields (nested `ethernetIp` settings block). */
function EthernetIpFieldsBlock({
  value,
  onChange,
}: {
  value: EthernetIpSettings;
  onChange: (patch: Partial<EthernetIpSettings>) => void;
}) {
  return (
    <>
      <TextField
        fullWidth size="small" label="Gateway" value={value.gateway}
        onChange={(e) => onChange({ gateway: e.target.value })}
        placeholder="10.10.10.10" sx={{ mb: 1 }}
      />
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" label="Path" value={value.path}
          onChange={(e) => onChange({ path: e.target.value })}
          placeholder="1,0 (empty for Micro800)" sx={{ flex: 1 }}
        />
        <TextField
          size="small" label="Timeout (ms)" value={value.timeoutMs}
          onChange={(e) => onChange({ timeoutMs: parseInt(e.target.value, 10) || 0 })}
          sx={{ flex: 1 }}
        />
      </Box>
      <FormControl fullWidth size="small" sx={{ mb: 1 }}>
        <InputLabel id="eip-plctype-label">PLC Type</InputLabel>
        <Select
          labelId="eip-plctype-label" label="PLC Type"
          value={value.plcType}
          onChange={(e) => onChange({ plcType: e.target.value as EipPlcType })}
        >
          <MenuItem value="ControlLogix">ControlLogix / CompactLogix</MenuItem>
          <MenuItem value="Plc5">PLC-5</MenuItem>
          <MenuItem value="Slc500">SLC 500</MenuItem>
          <MenuItem value="LogixPccc">Logix (PCCC)</MenuItem>
          <MenuItem value="Micro800">Micro800</MenuItem>
          <MenuItem value="MicroLogix">MicroLogix</MenuItem>
          <MenuItem value="Omron">Omron</MenuItem>
        </Select>
      </FormControl>
    </>
  );
}

/** ctrlX-specific fields (nested `ctrlX` settings block). */
function CtrlXFieldsBlock({
  value,
  onChange,
}: {
  value: CtrlXSettings;
  onChange: (patch: Partial<CtrlXSettings>) => void;
}) {
  return (
    <>
      <TextField
        fullWidth size="small" label="Address" value={value.address}
        onChange={(e) => onChange({ address: e.target.value })}
        placeholder="192.168.1.30" sx={{ mb: 1 }}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Checkbox size="small" checked={value.useSsl} onChange={(e) => onChange({ useSsl: e.target.checked })} />
        <Typography sx={{ fontSize: 12 }}>Use SSL (reverse proxy + auth)</Typography>
      </Box>
      {value.useSsl ? (
        <>
          <TextField
            fullWidth size="small" label="Bridge Path" value={value.bridgePath}
            onChange={(e) => onChange({ bridgePath: e.target.value })}
            sx={{ mb: 1 }}
          />
          <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
            <TextField
              size="small" label="Username" value={value.username ?? ''}
              onChange={(e) => onChange({ username: e.target.value || null })}
              sx={{ flex: 1 }}
            />
            <TextField
              size="small" label="Password" type="password" value={value.password ?? ''}
              onChange={(e) => onChange({ password: e.target.value || null })}
              sx={{ flex: 1 }}
            />
          </Box>
          <TextField
            fullWidth size="small" label="Token TTL fallback (minutes)"
            value={value.tokenTtlMinutes}
            onChange={(e) => onChange({ tokenTtlMinutes: parseInt(e.target.value, 10) || 0 })}
            sx={{ mb: 1 }}
          />
        </>
      ) : (
        <TextField
          fullWidth size="small" label="Direct Port" value={value.directPort}
          onChange={(e) => onChange({ directPort: parseInt(e.target.value, 10) || 0 })}
          sx={{ mb: 1 }}
        />
      )}
    </>
  );
}

/** Native ctrlX Data Layer fields (nested `ctrlXDataLayer` settings block). */
function CtrlXDataLayerFieldsBlock({
  value,
  onChange,
}: {
  value: CtrlXDataLayerSettings;
  onChange: (patch: Partial<CtrlXDataLayerSettings>) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <>
      <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.secondary', mb: 1 }}>
        Connection
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" label="Address" value={value.address}
          onChange={(e) => onChange({ address: e.target.value })}
          placeholder="192.168.1.32" sx={{ flex: 2, minWidth: 0 }}
        />
        <TextField
          size="small" label="Port" type="number" value={value.port}
          onChange={(e) => onChange({ port: parseInt(e.target.value, 10) || 0 })}
          sx={{ flex: 1, minWidth: 0 }}
        />
      </Box>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" label="Username" value={value.username ?? ''}
          onChange={(e) => onChange({ username: e.target.value || null })}
          sx={{ flex: 1, minWidth: 0 }}
        />
        <TextField
          size="small" label="Password" type="password" value={value.password ?? ''}
          onChange={(e) => onChange({ password: e.target.value || null })}
          sx={{ flex: 1, minWidth: 0 }}
        />
      </Box>
      <FormControlLabel
        sx={{ m: 0, alignItems: 'center' }}
        control={(
          <Checkbox
            size="small"
            checked={value.allowUntrustedCertificate}
            onChange={(e) => onChange({ allowUntrustedCertificate: e.target.checked })}
          />
        )}
        label={<Typography sx={{ fontSize: 12 }}>Allow untrusted certificate</Typography>}
      />
      <Typography sx={{ fontSize: 10, color: 'text.secondary', ml: 4.5, mb: 1.5, lineHeight: 1.5 }}>
        A factory-default ctrlX uses a self-signed certificate; enable this to connect until a trusted certificate is installed.
      </Typography>

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 1.25 }} />
      <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.secondary', mb: 0.5 }}>
        Subscription
      </Typography>
      <FormControlLabel
        sx={{ m: 0, mb: 0.5 }}
        control={(
          <Checkbox
            size="small"
            checked={value.useStatelessSubscription}
            onChange={(e) => onChange({ useStatelessSubscription: e.target.checked })}
          />
        )}
        label={<Typography sx={{ fontSize: 12 }}>Use stateless subscription</Typography>}
      />
      <TextField
        fullWidth size="small" label="Publish Interval (ms)" type="number"
        value={value.publishIntervalMs}
        onChange={(e) => onChange({ publishIntervalMs: parseInt(e.target.value, 10) || 0 })}
        sx={{ mb: 0.5 }}
      />

      <Button
        size="small"
        color="inherit"
        endIcon={advancedOpen ? <ExpandLess /> : <ExpandMore />}
        aria-expanded={advancedOpen}
        aria-controls="ctrlx-datalayer-advanced-fields"
        onClick={() => setAdvancedOpen(open => !open)}
        sx={{ px: 0.5, mb: 0.5, color: 'text.secondary', fontSize: 11, textTransform: 'none' }}
      >
        Advanced
      </Button>
      <Collapse in={advancedOpen}>
        <Box id="ctrlx-datalayer-advanced-fields">
          {!value.useStatelessSubscription && (
            <>
              <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
                <TextField
                  size="small" label="Keepalive Interval (ms)" type="number"
                  value={value.keepaliveIntervalMs}
                  onChange={(e) => onChange({ keepaliveIntervalMs: parseInt(e.target.value, 10) || 0 })}
                  sx={{ flex: 1, minWidth: 0 }}
                />
                <TextField
                  size="small" label="Error Interval (ms)" type="number"
                  value={value.errorIntervalMs}
                  onChange={(e) => onChange({ errorIntervalMs: parseInt(e.target.value, 10) || 0 })}
                  sx={{ flex: 1, minWidth: 0 }}
                />
              </Box>
              <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
                <TextField
                  size="small" label="Sampling Interval (µs)" type="number"
                  value={value.samplingIntervalUs}
                  onChange={(e) => onChange({ samplingIntervalUs: parseInt(e.target.value, 10) || 0 })}
                  sx={{ flex: 1, minWidth: 0 }}
                />
                <TextField
                  size="small" label="Queue Size" type="number"
                  value={value.queueSize}
                  onChange={(e) => onChange({ queueSize: parseInt(e.target.value, 10) || 0 })}
                  sx={{ flex: 1, minWidth: 0 }}
                />
              </Box>
              <Box sx={{ display: 'flex', gap: 1, mb: 1.5 }}>
                <FormControl size="small" sx={{ flex: 1, minWidth: 0 }}>
                  <InputLabel id="ctrlx-datalayer-queue-behaviour-label">Queue Behaviour</InputLabel>
                  <Select
                    labelId="ctrlx-datalayer-queue-behaviour-label"
                    label="Queue Behaviour"
                    value={value.queueBehaviour}
                    onChange={(e) => onChange({
                      queueBehaviour: e.target.value as CtrlXDataLayerSettings['queueBehaviour'],
                    })}
                  >
                    <MenuItem value="DiscardOldest">DiscardOldest</MenuItem>
                    <MenuItem value="DiscardNewest">DiscardNewest</MenuItem>
                  </Select>
                </FormControl>
                <FormControl size="small" sx={{ flex: 1, minWidth: 0 }}>
                  <InputLabel id="ctrlx-datalayer-value-change-label">Value Change</InputLabel>
                  <Select
                    labelId="ctrlx-datalayer-value-change-label"
                    label="Value Change"
                    value={value.valueChange}
                    onChange={(e) => onChange({
                      valueChange: e.target.value as CtrlXDataLayerSettings['valueChange'],
                    })}
                  >
                    <MenuItem value="Status">Status</MenuItem>
                    <MenuItem value="StatusValue">StatusValue</MenuItem>
                    <MenuItem value="StatusValueTimestamp">StatusValueTimestamp</MenuItem>
                  </Select>
                </FormControl>
              </Box>
            </>
          )}

          <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 1.25 }} />
          <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.secondary', mb: 1 }}>
            Discovery
          </Typography>
          <TextField
            fullWidth size="small" label="Browse Root Paths"
            value={value.browseRootPaths.join(', ')}
            onChange={(e) => onChange({ browseRootPaths: e.target.value.split(',').map(path => path.trim()) })}
            onBlur={() => onChange({ browseRootPaths: value.browseRootPaths.filter(Boolean) })}
            placeholder="plc/app/Application/sym"
            sx={{ mb: 0.25 }}
          />
          <Typography sx={{ fontSize: 10, color: 'text.secondary', mx: 0.5, mb: 1, lineHeight: 1.5 }}>
            Comma-separated browse roots. Leave empty to use configured signal parents and the Data Layer root.
          </Typography>
          <TextField
            fullWidth size="small" label="Max Subscription Nodes" type="number"
            value={value.maxSubscriptionNodes}
            onChange={(e) => onChange({ maxSubscriptionNodes: parseInt(e.target.value, 10) || 0 })}
            sx={{ mb: 1 }}
          />
        </Box>
      </Collapse>
    </>
  );
}

/** Keba-specific fields (nested `keba` settings block). */
function KebaFieldsBlock({
  value,
  onChange,
}: {
  value: KebaSettings;
  onChange: (patch: Partial<KebaSettings>) => void;
}) {
  return (
    <>
      <TextField
        fullWidth size="small" label="Host" value={value.host}
        onChange={(e) => onChange({ host: e.target.value })}
        placeholder="192.168.1.100" sx={{ mb: 1 }}
      />
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" label="HTTP Port" value={value.httpPort}
          onChange={(e) => onChange({ httpPort: parseInt(e.target.value, 10) || 0 })}
          sx={{ flex: 1 }}
        />
        <TextField
          size="small" label="WebSocket Port" value={value.wsPort}
          onChange={(e) => onChange({ wsPort: parseInt(e.target.value, 10) || 0 })}
          sx={{ flex: 1 }}
        />
      </Box>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" label="Username" value={value.username ?? ''}
          onChange={(e) => onChange({ username: e.target.value || null })}
          sx={{ flex: 1 }}
        />
        <TextField
          size="small" label="Password" type="password" value={value.password ?? ''}
          onChange={(e) => onChange({ password: e.target.value || null })}
          sx={{ flex: 1 }}
        />
      </Box>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" label="Cycle Time (ms)" value={value.cycleTimeMs}
          onChange={(e) => onChange({ cycleTimeMs: parseInt(e.target.value, 10) || 0 })}
          sx={{ flex: 1 }}
        />
        <TextField
          size="small" label="Browse roots (comma-sep.)"
          value={value.importRootPaths.join(', ')}
          onChange={(e) => onChange({ importRootPaths: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
          placeholder="SYS, PLC" sx={{ flex: 1 }}
        />
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Checkbox size="small" checked={value.useOnChange} onChange={(e) => onChange({ useOnChange: e.target.checked })} />
        <Typography sx={{ fontSize: 12 }}>Subscribe on-change (instead of periodic)</Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Checkbox size="small" checked={value.usePatternMatching} onChange={(e) => onChange({ usePatternMatching: e.target.checked })} />
        <Typography sx={{ fontSize: 12 }}>Infer direction from variable names (discovery)</Typography>
      </Box>
      {value.usePatternMatching && (
        <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
          <TextField
            size="small" label="Input patterns"
            value={value.inputPatterns.join(', ')}
            onChange={(e) => onChange({ inputPatterns: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
            placeholder="input" sx={{ flex: 1 }}
          />
          <TextField
            size="small" label="Output patterns"
            value={value.outputPatterns.join(', ')}
            onChange={(e) => onChange({ outputPatterns: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
            placeholder="output" sx={{ flex: 1 }}
          />
        </Box>
      )}
    </>
  );
}

/** Festo-specific fields (nested `festo` settings block). */
function FestoFieldsBlock({
  value,
  onChange,
}: {
  value: FestoSettings;
  onChange: (patch: Partial<FestoSettings>) => void;
}) {
  return (
    <>
      <TextField
        fullWidth size="small" label="Host" value={value.host}
        onChange={(e) => onChange({ host: e.target.value })}
        placeholder="192.168.1.10" sx={{ mb: 1 }}
      />
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" label="RSC Port" value={value.port}
          onChange={(e) => onChange({ port: parseInt(e.target.value, 10) || 0 })}
          sx={{ flex: 1 }}
        />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flex: 1 }}>
          <Checkbox size="small" checked={value.useTls} onChange={(e) => onChange({ useTls: e.target.checked })} />
          <Typography sx={{ fontSize: 12 }}>Use TLS</Typography>
        </Box>
      </Box>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" label="Username" value={value.username ?? ''}
          onChange={(e) => onChange({ username: e.target.value || null })}
          sx={{ flex: 1 }}
        />
        <TextField
          size="small" label="Password" type="password" value={value.password ?? ''}
          onChange={(e) => onChange({ password: e.target.value || null })}
          sx={{ flex: 1 }}
        />
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Checkbox size="small" checked={value.useSubscription} onChange={(e) => onChange({ useSubscription: e.target.checked })} />
        <Typography sx={{ fontSize: 12 }}>Use subscription (falls back to polling)</Typography>
      </Box>
      {value.useSubscription && (
        <TextField
          fullWidth size="small" label="Subscription cycle (ms)"
          value={value.subscriptionCycleMs}
          onChange={(e) => onChange({ subscriptionCycleMs: parseInt(e.target.value, 10) || 0 })}
          sx={{ mb: 1 }}
        />
      )}
      <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', mb: 1 }}>
        Only one Festo (PLCnext RSC) interface per CONNECT process — connect a second PLCnext via OPC UA.
      </Typography>
    </>
  );
}

/** FANUC-specific fields (nested `fanuc` settings block). */
function FanucFieldsBlock({
  value,
  onChange,
}: {
  value: FanucSettings;
  onChange: (patch: Partial<FanucSettings>) => void;
}) {
  return (
    <>
      <TextField
        fullWidth size="small" label="Address (127.0.0.1 for RoboGuide on this PC)" value={value.address}
        onChange={(e) => onChange({ address: e.target.value })}
        placeholder="127.0.0.1" sx={{ mb: 1 }}
      />
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" label="Port (RoboGuide: robot 1 = 60008, robot 2 = 60009, …)" value={value.port}
          onChange={(e) => onChange({ port: parseInt(e.target.value, 10) || 0 })}
          sx={{ flex: 2 }}
        />
        <TextField
          size="small" label="Axes" value={value.axisCount}
          onChange={(e) => onChange({ axisCount: parseInt(e.target.value, 10) || 0 })}
          sx={{ flex: 1 }}
        />
      </Box>
      <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', mb: 1 }}>
        Signal addresses are FANUC signal names (do4, di3, ui1, …). Axes &gt; 0 publishes joint positions
        as axis1…axisN float signals.
      </Typography>
    </>
  );
}

/** Denso-specific fields (nested `denso` settings block). */
function DensoFieldsBlock({
  value,
  onChange,
}: {
  value: DensoSettings;
  onChange: (patch: Partial<DensoSettings>) => void;
}) {
  return (
    <>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" label="Host" value={value.host}
          onChange={(e) => onChange({ host: e.target.value })}
          placeholder="127.0.0.1" sx={{ flex: 2 }}
        />
        <FormControl size="small" sx={{ flex: 1 }}>
          <InputLabel id="denso-ct-label">Controller</InputLabel>
          <Select
            labelId="denso-ct-label" label="Controller"
            value={value.controllerType}
            onChange={(e) => onChange({ controllerType: e.target.value as DensoControllerType })}
          >
            <MenuItem value="RC8">RC8</MenuItem>
            <MenuItem value="RC9">RC9</MenuItem>
          </Select>
        </FormControl>
      </Box>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          size="small" label="Controller Name" value={value.controllerName}
          onChange={(e) => onChange({ controllerName: e.target.value })}
          placeholder="Robot1" sx={{ flex: 1 }}
        />
        <TextField
          size="small" label="Axes" value={value.axisCount}
          onChange={(e) => onChange({ axisCount: parseInt(e.target.value, 10) || 0 })}
          sx={{ width: 80 }}
        />
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Checkbox size="small" checked={value.connectRealRobot} onChange={(e) => onChange({ connectRealRobot: e.target.checked })} />
        <Typography sx={{ fontSize: 12 }}>Connect to real robot (instead of WinCaps VRC)</Typography>
      </Box>
      {!value.connectRealRobot && (
        <TextField
          fullWidth size="small" label="WinCaps project (.WPJ path on the CONNECT machine)"
          value={value.wincapsProject}
          onChange={(e) => onChange({ wincapsProject: e.target.value })}
          placeholder="C:\Projects\Cell1\Cell1.WPJ" sx={{ mb: 1 }}
        />
      )}
      <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', mb: 1 }}>
        Signal addresses are VRC symbols: IO&lt;n&gt; (bool), I&lt;n&gt; (int), F&lt;n&gt; (float), S&lt;n&gt; (string).
      </Typography>
    </>
  );
}

/** ABB RobotStudio-specific fields (nested `abbRobotStudio` settings block). */
function AbbRobotStudioFieldsBlock({
  value,
  onChange,
}: {
  value: AbbRobotStudioSettings;
  onChange: (patch: Partial<AbbRobotStudioSettings>) => void;
}) {
  return (
    <>
      <TextField
        fullWidth size="small" label="Shared Memory Name" value={value.sharedMemoryName}
        onChange={(e) => onChange({ sharedMemoryName: e.target.value })}
        placeholder="SIMITShared Memory" sx={{ mb: 1 }}
      />
      <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', mb: 1 }}>
        CONNECT creates the SIMIT shared memory; attach RobotStudio&apos;s SIMIT connection to it.
        Same machine only. Joint* float outputs arrive in rad and are exposed in deg.
      </Typography>
    </>
  );
}

function EditInterfaceDialog({ iface, open, onClose }: { iface: ConnectInterface; open: boolean; onClose: () => void }) {
  // ── Common fields — unchanged behavior (Enabled, UpdateCycleMs) plus AllowWebToPlc ──
  const [enabled, setEnabled] = useState(iface.enabled);
  const [updateCycleMs, setUpdateCycleMs] = useState(String(iface.updateCycleMs ?? 50));
  const [allowWebToPlc, setAllowWebToPlc] = useState(Boolean(iface.allowWebToPlc));

  // ── Flat type-specific fields (OpcUa / S7 / MQTT) — unchanged ──
  const [endpoint, setEndpoint] = useState((iface.endpoint as string) ?? 'opc.tcp://localhost:4840');
  const [ipAddress, setIpAddress] = useState((iface.ipAddress as string) ?? '192.168.1.50');
  const [rack, setRack] = useState(String(iface.rack ?? 0));
  const [slot, setSlot] = useState(String(iface.slot ?? 1));
  const [brokerUrl, setBrokerUrl] = useState((iface.brokerUrl as string) ?? 'mqtt://localhost:1883');

  // ── Nested settings blocks — seeded from the existing interface, falling back to
  // backend defaults for any field a legacy/partial config doesn't have yet. ──
  const [twinCat, setTwinCat] = useState<TwinCatSettings>(
    () => ({ ...TWINCAT_SETTINGS_DEFAULTS, ...iface.twinCat }),
  );
  const [modbus, setModbus] = useState<ModbusSettings>(() => ({
    ...(iface.type === 'ModbusServer' ? MODBUS_SERVER_SETTINGS_DEFAULTS : MODBUS_SETTINGS_DEFAULTS),
    ...iface.modbus,
  }));
  const [ethernetIp, setEthernetIp] = useState<EthernetIpSettings>(
    () => ({ ...ETHERNETIP_SETTINGS_DEFAULTS, ...iface.ethernetIp }),
  );
  const [ctrlX, setCtrlX] = useState<CtrlXSettings>(
    () => ({ ...CTRLX_SETTINGS_DEFAULTS, ...iface.ctrlX }),
  );
  const [ctrlXDataLayer, setCtrlXDataLayer] = useState<CtrlXDataLayerSettings>(() => ({
    ...CTRLXDATALAYER_SETTINGS_DEFAULTS,
    ...iface.ctrlXDataLayer,
    browseRootPaths: [
      ...(iface.ctrlXDataLayer?.browseRootPaths ?? CTRLXDATALAYER_SETTINGS_DEFAULTS.browseRootPaths),
    ],
  }));
  const [keba, setKeba] = useState<KebaSettings>(
    () => ({ ...KEBA_SETTINGS_DEFAULTS, ...iface.keba }),
  );
  const [festo, setFesto] = useState<FestoSettings>(
    () => ({ ...FESTO_SETTINGS_DEFAULTS, ...iface.festo }),
  );
  const [fanuc, setFanuc] = useState<FanucSettings>(
    () => ({ ...FANUC_SETTINGS_DEFAULTS, ...iface.fanuc }),
  );
  const [denso, setDenso] = useState<DensoSettings>(
    () => ({ ...DENSO_SETTINGS_DEFAULTS, ...iface.denso }),
  );
  const [abbRobotStudio, setAbbRobotStudio] = useState<AbbRobotStudioSettings>(
    () => ({ ...ABB_ROBOTSTUDIO_SETTINGS_DEFAULTS, ...iface.abbRobotStudio }),
  );

  const patchTwinCat = useCallback((patch: Partial<TwinCatSettings>) => setTwinCat(prev => ({ ...prev, ...patch })), []);
  const patchModbus = useCallback((patch: Partial<ModbusSettings>) => setModbus(prev => ({ ...prev, ...patch })), []);
  const patchEthernetIp = useCallback((patch: Partial<EthernetIpSettings>) => setEthernetIp(prev => ({ ...prev, ...patch })), []);
  const patchCtrlX = useCallback((patch: Partial<CtrlXSettings>) => setCtrlX(prev => ({ ...prev, ...patch })), []);
  const patchCtrlXDataLayer = useCallback((patch: Partial<CtrlXDataLayerSettings>) => setCtrlXDataLayer(prev => ({ ...prev, ...patch })), []);
  const patchKeba = useCallback((patch: Partial<KebaSettings>) => setKeba(prev => ({ ...prev, ...patch })), []);
  const patchFesto = useCallback((patch: Partial<FestoSettings>) => setFesto(prev => ({ ...prev, ...patch })), []);
  const patchFanuc = useCallback((patch: Partial<FanucSettings>) => setFanuc(prev => ({ ...prev, ...patch })), []);
  const patchDenso = useCallback((patch: Partial<DensoSettings>) => setDenso(prev => ({ ...prev, ...patch })), []);
  const patchAbbRobotStudio = useCallback((patch: Partial<AbbRobotStudioSettings>) => setAbbRobotStudio(prev => ({ ...prev, ...patch })), []);

  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const updates: Partial<ConnectInterface> = {
        enabled,
        updateCycleMs: parseInt(updateCycleMs, 10) || 50,
        allowWebToPlc,
      };
      if (iface.type === 'OpcUa') updates.endpoint = endpoint;
      else if (iface.type === 'S7') { updates.ipAddress = ipAddress; updates.rack = parseInt(rack, 10); updates.slot = parseInt(slot, 10); }
      else if (iface.type === 'MQTT') updates.brokerUrl = brokerUrl;
      else if (iface.type === 'TwinCat') updates.twinCat = twinCat;
      else if (iface.type === 'Modbus' || iface.type === 'ModbusServer') updates.modbus = modbus;
      else if (iface.type === 'EthernetIp') updates.ethernetIp = ethernetIp;
      else if (iface.type === 'CtrlX') updates.ctrlX = ctrlX;
      else if (iface.type === 'CtrlXDataLayer') updates.ctrlXDataLayer = ctrlXDataLayer;
      else if (iface.type === 'Keba') updates.keba = keba;
      else if (iface.type === 'Festo') updates.festo = festo;
      else if (iface.type === 'Fanuc') updates.fanuc = fanuc;
      else if (iface.type === 'Denso') updates.denso = denso;
      else if (iface.type === 'AbbRobotStudio') updates.abbRobotStudio = abbRobotStudio;
      await updateInterface(iface.id, updates);
      onClose();
    } catch { /* logged in store */ }
    setSaving(false);
  }, [iface, endpoint, ipAddress, rack, slot, brokerUrl, enabled, updateCycleMs, allowWebToPlc, twinCat, modbus, ethernetIp, ctrlX, ctrlXDataLayer, keba, festo, fanuc, denso, abbRobotStudio, onClose]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14 }}>
        <Edit sx={{ color: 'primary.main' }} />
        Edit {interfaceTypeLabel(iface.type)} Interface
      </DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, mb: 0.5 }}>
          <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} size="small" />
          <Typography sx={{ fontSize: 13 }}>Enabled</Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Checkbox checked={allowWebToPlc} onChange={(e) => setAllowWebToPlc(e.target.checked)} size="small" />
          <Typography sx={{ fontSize: 13 }}>Allow Web → PLC writes</Typography>
        </Box>
        <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', ml: 4.5, mt: -0.5, mb: 1.5, lineHeight: 1.5 }}>
          Lets viewer users write signal values back to the PLC. Leave off for monitor-only delivery.
        </Typography>

        {iface.type === 'OpcUa' && (
          <TextField fullWidth size="small" label="Endpoint URL" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} sx={{ mb: 1 }} />
        )}

        {iface.type === 'S7' && (
          <>
            <TextField fullWidth size="small" label="IP Address" value={ipAddress} onChange={(e) => setIpAddress(e.target.value)} sx={{ mb: 1 }} />
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField size="small" label="Rack" value={rack} onChange={(e) => setRack(e.target.value)} sx={{ flex: 1 }} />
              <TextField size="small" label="Slot" value={slot} onChange={(e) => setSlot(e.target.value)} sx={{ flex: 1 }} />
            </Box>
          </>
        )}

        {iface.type === 'MQTT' && (
          <TextField fullWidth size="small" label="Broker URL" value={brokerUrl} onChange={(e) => setBrokerUrl(e.target.value)} sx={{ mb: 1 }} />
        )}

        {iface.type === 'TwinCat' && <TwinCatFieldsBlock value={twinCat} onChange={patchTwinCat} />}

        {(iface.type === 'Modbus' || iface.type === 'ModbusServer') && (
          <ModbusFieldsBlock value={modbus} onChange={patchModbus} isServerMode={iface.type === 'ModbusServer'} />
        )}

        {iface.type === 'EthernetIp' && <EthernetIpFieldsBlock value={ethernetIp} onChange={patchEthernetIp} />}

        {iface.type === 'CtrlX' && <CtrlXFieldsBlock value={ctrlX} onChange={patchCtrlX} />}

        {iface.type === 'CtrlXDataLayer' && (
          <CtrlXDataLayerFieldsBlock value={ctrlXDataLayer} onChange={patchCtrlXDataLayer} />
        )}

        {iface.type === 'Keba' && <KebaFieldsBlock value={keba} onChange={patchKeba} />}

        {iface.type === 'Festo' && <FestoFieldsBlock value={festo} onChange={patchFesto} />}

        {iface.type === 'Fanuc' && <FanucFieldsBlock value={fanuc} onChange={patchFanuc} />}

        {iface.type === 'Denso' && <DensoFieldsBlock value={denso} onChange={patchDenso} />}

        {iface.type === 'AbbRobotStudio' && <AbbRobotStudioFieldsBlock value={abbRobotStudio} onChange={patchAbbRobotStudio} />}

        <TextField fullWidth size="small" label="Update Cycle (ms)" value={updateCycleMs} onChange={(e) => setUpdateCycleMs(e.target.value)} sx={{ mt: 1 }} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={saving} sx={{ textTransform: 'none' }}>
          {saving ? 'Saving...' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Signal List View (tree: Interface > Topic > Signals, shared SignalBadge chips) ──

/** Stable empty map so the links-lookup fallback never re-allocates per render. */
const EMPTY_LINKS: ReadonlyMap<string, { path: string; slot: string; placedId: string }[]> = new Map();

const SIGNAL_ROW_HEIGHT = 34;
const CONNECT_SIGNAL_NAME_MAX = 24;
const CONNECT_SIGNAL_SUBTITLE_MAX = 32;
const GROUP_ROW_HEIGHT = 24;
/** Touch press duration that stands in for a right-click on a signal row. */
const LONG_PRESS_MS = 500;

type SignalListRow =
  | { kind: 'group'; topic: string; total: number }
  /** A level of the derived MQTT topic tree (plan-352 F1). `path` is its collapse identity,
   *  `count` the number of signals in its subtree. */
  | { kind: 'treeNode'; path: string; label: string; depth: number; count: number }
  /** `flat` = an interface-level signal (not topic-nested) — these are the manually editable ones
   *  and, for MQTT, the leaves of the derived topic tree; MQTT ProcessImage topic signals carry
   *  import-owned byte offsets and stay import-only.
   *  `depth` is set for tree leaves and drives their indentation (undefined = flat rendering). */
  | { kind: 'signal'; sig: ConnectInterfaceSignal; flat?: boolean; topic?: string; depth?: number };

/**
 * Derive the transient set of topics opened by the active signal filter.
 * Criteria changes open every current match; live filter ticks only add newly matching topics
 * and prune topics that stopped matching.
 */
export function computeFilterAutoOpen(
  existing: Set<string>,
  prevMatches: Set<string> | null,
  currentMatches: Set<string>,
  criteriaChanged: boolean,
): Set<string> {
  let next: Set<string>;
  if (criteriaChanged || prevMatches === null) {
    next = new Set(currentMatches);
  } else {
    next = new Set<string>();
    for (const topic of existing) if (currentMatches.has(topic)) next.add(topic);
    for (const topic of currentMatches) if (!prevMatches.has(topic)) next.add(topic);
  }

  if (next.size === existing.size) {
    let same = true;
    for (const topic of next) {
      if (!existing.has(topic)) {
        same = false;
        break;
      }
    }
    if (same) return existing;
  }
  return next;
}

// ── Memoized signal row (plan-234 §10-F6) ──────────────────────────────────

interface SignalRowItemProps {
  sig: ConnectInterfaceSignal;
  direction: 'input' | 'output';
  plcType: string;
  /** True when a model signal with this symbol name exists (auto coupling). */
  inModel: boolean;
  hasTopics: boolean;
  /** Tree depth of this leaf in the derived MQTT topic tree; undefined = not in a tree
   *  (flat list / topic group), which keeps the previous single-step indentation. */
  depth?: number;
  viewer: ReturnType<typeof useViewer>;
  /**
   * Activity-indicator feature gate (plan-344 Phase 1). The activity ENUM itself
   * is no longer a prop: the row derives it in a leaf hook coupled to the shared
   * 200-ms UI ticker, so a value change anywhere in the interface no longer
   * invalidates the whole list body just to keep this indicator fresh.
   * `false` → exactly the pre-indicator rendering (no opacity / status icon).
   */
  indicatorOn: boolean;
  /** Linked-target label (e.g. "Turntable · Destination"), or undefined if unlinked. */
  linkedLabel?: string;
  /** Node path of the linked target, to navigate to on click. */
  linkedPath?: string;
  /** Manual-edit callbacks (stable refs so memo keeps working) — undefined hides the hover icons. */
  onEdit?: (sig: ConnectInterfaceSignal) => void;
  onDelete?: (sig: ConnectInterfaceSignal) => void;
  /** Bridge this signal 1:1 to a signal of another interface (plan-257) — undefined hides the icon. */
  onBridge?: (sig: ConnectInterfaceSignal) => void;
  /** Toggle CONNECT's persisted historian Record flag. */
  onRecordChange?: (sig: ConnectInterfaceSignal, record: boolean, topic?: string) => void;
  topic?: string;
  interfaceId: string;
  recordPending?: boolean;
  /** This configured signal was rejected by the current license budget. */
  limitExceeded?: boolean;
  /** Part of the current multi-selection (bulk delete). */
  selected?: boolean;
  /** Click selection. The row passes its own `topic` so the selection key stays unambiguous. */
  onSelect?: (sig: ConnectInterfaceSignal, e: React.MouseEvent, topic?: string) => void;
  /** Right-click / long-press at viewport coordinates — opens the row's action menu. */
  onContextMenu?: (sig: ConnectInterfaceSignal, x: number, y: number, topic?: string) => void;
}

/**
 * One signal row. Wrapped in `React.memo` (§10-F6): re-renders only when a
 * structural prop changes — the two time-variant pieces are owned by the row
 * itself (plan-344 Phase 1):
 *   • the live VALUE via `useThrottledSignalValue` (per-signal subscription,
 *     coalesced onto the shared 200-ms flush), and
 *   • the derived ACTIVITY enum via `useSignalActivityValue` (pull consumer on
 *     the same shared ticker, `setState` skipped on an unchanged enum).
 * Only rows the virtualizer has actually mounted therefore subscribe, and the
 * parent list body no longer re-renders on the value bus at all.
 *
 * When `activity` is inactive (stale / no-source) the row is dimmed and shows a
 * status icon + short text hint (ISA-101 gray-first + A11y — never color alone).
 * Active/local rows render neutrally at full opacity.
 */
const SignalRowItem = memo(function SignalRowItem({
  sig, direction, plcType, inModel, hasTopics, depth, viewer, indicatorOn, linkedLabel, linkedPath,
  onEdit, onDelete, onBridge, onRecordChange, topic, interfaceId, recordPending, limitExceeded,
  selected, onSelect, onContextMenu,
}: SignalRowItemProps) {
  const signalStore = viewer.signalStore ?? null;
  // Live value — the row owns the subscription (plan-344 F1). `undefined` while
  // the store has never seen this symbol; SignalBadge renders that as "—".
  const raw = useThrottledSignalValue(signalStore, sig.name);
  // Derived activity — connection-based and therefore NOT refreshed by the value
  // bus; the leaf hook pulls it off the shared 5-Hz tick instead.
  const activity = useSignalActivityValue(signalStore, sig.name, indicatorOn, getViewerMode);
  const opacity = activity !== undefined ? activityOpacity(activity) : 1;
  const marker = activity !== undefined ? activityStatusMarker(activity) : 'none';
  const hint = activity !== undefined ? activityStatusHint(activity) : '';
  const StatusIcon = marker === 'warn' ? WarningAmber : marker === 'empty' ? RemoveCircleOutline : null;
  const statusColor = marker === 'warn' ? ISA_AMBER : 'rgba(255,255,255,0.6)';
  // Inactive state (stale / no-source) is shown as a bare icon only — the text
  // hint stays as a hover tooltip so the row stays compact (no inline label).

  // The WHOLE row is a Shift+Drag source (plan-246 F8) — the chip alone is too
  // small a grab handle. Same payload as the chip; Shift+Click without movement
  // stays inert (the drag store suppresses the trailing click).
  // Long-press = the touch equivalent of right-click (there is no contextmenu event worth relying
  // on across mobile browsers). Armed on a touch/pen press and cancelled by movement, release or a
  // cancelled pointer, so a scroll fling never opens the menu.
  const longPressRef = useRef<number | null>(null);
  const cancelLongPress = useCallback(() => {
    if (longPressRef.current !== null) {
      window.clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }, []);
  useEffect(() => cancelLongPress, [cancelLongPress]);

  const onRowPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (onContextMenu && e.pointerType !== 'mouse') {
      const { clientX, clientY } = e;
      cancelLongPress();
      longPressRef.current = window.setTimeout(() => {
        longPressRef.current = null;
        onContextMenu(sig, clientX, clientY, topic);
      }, LONG_PRESS_MS);
    }
    if (!e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const source = viewer.signalStore?.getSignalMeta(sig.name)?.source;
    armSignalDrag(
      // A CONNECT row knows its own interface — origin is never guessed here.
      { name: sig.name, direction, plcType, address: sig.protocolAddress, comment: sig.comment, source, interfaceId, topic, origin: 'connect' },
      e.clientX,
      e.clientY,
    );
  }, [viewer, sig, sig.name, sig.protocolAddress, sig.comment, direction, plcType, interfaceId, topic,
      onContextMenu, cancelLongPress]);

  return (
    <Box
      onPointerDown={onRowPointerDown}
      onPointerUp={cancelLongPress}
      onPointerMove={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onClick={onSelect ? (e) => onSelect(sig, e, topic) : undefined}
      onContextMenu={onContextMenu
        ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(sig, e.clientX, e.clientY, topic); }
        : undefined}
      aria-selected={onSelect ? selected === true : undefined}
      data-rv-selected={selected ? '1' : undefined}
      data-rv-depth={depth}
      sx={{
        // Tree leaves indent by their level; everything else keeps the previous flat/topic step.
        height: SIGNAL_ROW_HEIGHT, gap: 0.5, pr: 0.5,
        pl: depth !== undefined ? 0.5 + depth : hasTopics ? 1.5 : 0.5,
        display: 'flex', alignItems: 'center', width: '100%',
        opacity,
        cursor: onSelect ? 'default' : undefined,
        // Selection wins over the license-limit tint: while picking rows for a bulk action, what is
        // picked must stay unambiguous. The amber limit marker keeps its own left border below.
        bgcolor: selected ? 'rgba(79,195,247,0.16)' : limitExceeded ? `${ISA_AMBER}14` : undefined,
        borderLeft: selected
          ? '2px solid #4fc3f7'
          : limitExceeded ? `2px solid ${ISA_AMBER}` : '2px solid transparent',
        '&:hover': { bgcolor: selected ? 'rgba(79,195,247,0.22)' : 'rgba(79,195,247,0.06)' },
        // Reveal the action icons on keyboard focus too — they are in the tab
        // order, so they must never be invisible while focused.
        '&:hover .rv-sig-actions, &:focus-within .rv-sig-actions': { opacity: 1 },
      }}
    >
      {inModel && (
        <Tooltip title="Used by the model — a component (drive / cylinder / sensor) references this signal, coupled by name" placement="left" disableInteractive>
          <Hub sx={{ fontSize: 12, color: '#4fc3f7', flexShrink: 0 }} />
        </Tooltip>
      )}
      {limitExceeded && (
        <Tooltip title="Signal limit - this signal is not being served" placement="left" disableInteractive>
          <WarningAmber role="img" aria-label="Signal limit" sx={{ fontSize: 12, color: ISA_AMBER, flexShrink: 0 }} />
        </Tooltip>
      )}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: 11, color: limitExceeded ? ISA_AMBER : 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {middleTruncate(sig.name, CONNECT_SIGNAL_NAME_MAX)}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
          <Typography
            noWrap
            sx={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}
          >
            {middleTruncate(
              `${sig.protocolAddress}${sig.dataType ? ` · ${sig.dataType}` : ''}${sig.comment ? ` · ${sig.comment}` : ''}`,
              CONNECT_SIGNAL_SUBTITLE_MAX,
            )}
          </Typography>
          {StatusIcon && (
            <Tooltip title={hint} placement="left" disableInteractive>
              <StatusIcon sx={{ fontSize: 10, color: statusColor, flexShrink: 0 }} />
            </Tooltip>
          )}
        </Box>
      </Box>
      {linkedLabel && (
        <LinkIcon
          // consumeSignalDragClick: a Shift+press/drag that ends on this icon must not navigate.
          onClick={(e) => { e.stopPropagation(); if (consumeSignalDragClick()) return; if (linkedPath) navigateToRef(viewer, linkedPath); }}
          sx={{ fontSize: 12, color: '#4fc3f7', flexShrink: 0, cursor: linkedPath ? 'pointer' : 'default', '&:hover': { color: 'text.primary' } }}
        />
      )}
      {/* Historian REC dot — persistent state indicator for recorded signals.
          Click = view history (opens the trend panel with this signal preselected);
          stopping the recording lives in the hover action cluster below. */}
      {onRecordChange && sig.record === true && (
        <Tooltip title="Recording to historian — click to view history" disableInteractive>
          <IconButton
            size="small"
            aria-label={`Show historian trend for ${sig.name}`}
            disabled={recordPending}
            onClick={(event) => { event.stopPropagation(); historianStore.openPanel(sig.name); }}
            sx={{ p: 0.25, flexShrink: 0, opacity: recordPending ? 0.4 : 1 }}
          >
            <FiberManualRecord sx={{ fontSize: 9, color: '#4fc3f7' }} />
          </IconButton>
        </Tooltip>
      )}
      {(onEdit || onDelete || onBridge || onRecordChange) && (
        <Box className="rv-sig-actions" sx={{ display: 'flex', flexShrink: 0, opacity: 0, transition: 'opacity 0.15s' }}>
          {onRecordChange && (
            <Tooltip title={sig.record ? 'Stop recording this signal in the historian' : 'Record this signal in the historian'} disableInteractive>
              <IconButton
                size="small"
                aria-label={`${sig.record ? 'Disable' : 'Enable'} historian recording for ${sig.name}`}
                disabled={recordPending}
                onClick={(e) => { e.stopPropagation(); onRecordChange(sig, sig.record !== true, topic); }}
                sx={{ p: 0.25 }}
              >
                {/* Record/Stop pair (camera-app metaphor): the stop action is a square-in-circle,
                    visually distinct from the persistent REC status dot — never two look-alike dots. */}
                {sig.record
                  ? <StopCircle sx={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', '&:hover': { color: ISA_RED } }} />
                  : <FiberManualRecord sx={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }} />}
              </IconButton>
            </Tooltip>
          )}
          {onBridge && (
            <Tooltip title="Bridge to another interface (1:1 signal mapping)" disableInteractive>
              <IconButton size="small" aria-label={`Bridge signal '${sig.name}'`} onClick={(e) => { e.stopPropagation(); onBridge(sig); }} sx={{ p: 0.25 }}>
                <SwapHoriz sx={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }} />
              </IconButton>
            </Tooltip>
          )}
          {onEdit && (
            <Tooltip title="Edit signal" disableInteractive>
              <IconButton size="small" aria-label={`Edit signal '${sig.name}'`} onClick={(e) => { e.stopPropagation(); onEdit(sig); }} sx={{ p: 0.25 }}>
                <Edit sx={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }} />
              </IconButton>
            </Tooltip>
          )}
          {onDelete && (
            <Tooltip title="Delete signal" disableInteractive>
              <IconButton size="small" aria-label={`Delete signal '${sig.name}'`} onClick={(e) => { e.stopPropagation(); onDelete(sig); }} sx={{ p: 0.25, '&:hover': { color: ISA_RED } }}>
                <Delete sx={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      )}
      {/* Full drag payload (address/comment; source comes from the mirrored store
          meta) so a Shift+Drag from the CONNECT list carries everything (F11). */}
      <SignalBadge
        direction={direction}
        plcType={plcType}
        raw={raw}
        viewer={viewer}
        signalName={sig.name}
        address={sig.protocolAddress}
        comment={sig.comment}
        dragSource={{ interfaceId, topic }}
      />
    </Box>
  );
});

// ── Filter popover (plan-234 §3.4 / F8) ─────────────────────────────────────

const FILTER_TYPES: PlcTypeKind[] = ['Bool', 'Int', 'Float'];

/**
 * Compact filter panel opened from the list-header trigger. Bundles the text
 * search and the three facets (Active, Type, Connected) that used to be a
 * permanent text field; matches the dark ConnectPanel theme. Reset clears all.
 */
function SignalFilterPopover({
  anchorEl,
  onClose,
  filterState,
  setFilterState,
  toggleType,
  onReset,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  filterState: SignalFilterState;
  setFilterState: React.Dispatch<React.SetStateAction<SignalFilterState>>;
  toggleType: (k: PlcTypeKind) => void;
  onReset: () => void;
}) {
  const labelSx = { fontSize: 10, color: 'rgba(255,255,255,0.65)', textTransform: 'uppercase', letterSpacing: 0.4 } as const;
  const groupSx = {
    '& .MuiToggleButton-root': {
      fontSize: 10, textTransform: 'none', py: 0.25, px: 0.75, color: 'rgba(255,255,255,0.7)',
      borderColor: 'rgba(255,255,255,0.15)',
      '&.Mui-selected': { color: '#fff', bgcolor: 'rgba(79,195,247,0.25)', '&:hover': { bgcolor: 'rgba(79,195,247,0.35)' } },
    },
  } as const;

  // Active and Connected are identical single-choice facets; render both from one
  // helper. (Type stays separate below — it is multi-select with per-button toggles.)
  const exclusiveFacet = (
    label: string,
    value: string,
    options: ReadonlyArray<readonly [string, string]>,
    onChange: (v: string) => void,
  ) => (
    <Box>
      <Typography sx={labelSx}>{label}</Typography>
      <ToggleButtonGroup
        size="small"
        exclusive
        fullWidth
        value={value}
        onChange={(_, v) => { if (v) onChange(v); }}
        sx={{ mt: 0.25, ...groupSx }}
      >
        {options.map(([v, lbl]) => <ToggleButton key={v} value={v}>{lbl}</ToggleButton>)}
      </ToggleButtonGroup>
    </Box>
  );

  return (
    <Popover
      open={!!anchorEl}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { sx: { p: 1, width: 260, bgcolor: 'rgba(30,30,30,0.85)', backdropFilter: 'blur(calc(16px * var(--rv-ui-blur-scale, 1)))', backgroundImage: 'none' } } }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {/* Text search */}
        <TextField
          autoFocus
          size="small"
          fullWidth
          value={filterState.text}
          onChange={(e) => setFilterState((prev) => ({ ...prev, text: e.target.value }))}
          placeholder="Filter signals..."
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <Search sx={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }} />
              </InputAdornment>
            ),
          }}
          sx={{ '& .MuiInputBase-input': { fontSize: 11, py: 0.5 } }}
        />

        {/* Active facet */}
        {exclusiveFacet(
          'Active',
          filterState.active,
          [['all', 'All'], ['active', 'Active'], ['inactive', 'Inactive']],
          (v) => setFilterState((prev) => ({ ...prev, active: v as SignalFilterState['active'] })),
        )}

        {/* Type facet (multi-select) */}
        <Box>
          <Typography sx={labelSx}>Type</Typography>
          <ToggleButtonGroup
            size="small"
            fullWidth
            value={FILTER_TYPES.filter((k) => filterState.types.has(k))}
            sx={{ mt: 0.25, ...groupSx }}
          >
            {FILTER_TYPES.map((k) => (
              <ToggleButton key={k} value={k} onClick={() => toggleType(k)}>{k}</ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>

        {/* Connected facet */}
        {exclusiveFacet(
          'Connected',
          filterState.connected,
          [['all', 'All'], ['connected', 'Connected'], ['disconnected', 'Disconnected']],
          (v) => setFilterState((prev) => ({ ...prev, connected: v as SignalFilterState['connected'] })),
        )}

        {/* Model-coupling facet — Auto (matching signal name) vs. Linked (manual
            Planner link) vs. Unbound (not used by the model). */}
        {exclusiveFacet(
          'In Model',
          filterState.binding,
          [['all', 'All'], ['auto', 'Auto'], ['manual', 'Linked'], ['none', 'Unbound']],
          (v) => setFilterState((prev) => ({ ...prev, binding: v as SignalFilterState['binding'] })),
        )}

        {/* Historian facet — signals with the persisted Record flag (plan-209). */}
        {exclusiveFacet(
          'Historian',
          filterState.recorded,
          [['all', 'All'], ['recorded', 'Recorded']],
          (v) => setFilterState((prev) => ({ ...prev, recorded: v as SignalFilterState['recorded'] })),
        )}

        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            size="small"
            onClick={onReset}
            disabled={activeFilterCount(filterState) === 0}
            sx={{ fontSize: 10, textTransform: 'none', minWidth: 0, color: 'rgba(255,255,255,0.7)' }}
          >
            Reset
          </Button>
        </Box>
      </Box>
    </Popover>
  );
}

/**
 * Searchable, virtualized signal view grouped as Interface > Topic > Signals (topic-bundled MQTT
 * ProcessImage) or Interface > Signals (flat, other protocols). Each signal renders with the shared
 * SignalBadge chip; live values stream in from the viewer SignalStore.
 */
export function SignalListView({ iface, overLimitSignals, onBridgeSignal }: {
  iface: ConnectInterface;
  overLimitSignals: readonly string[];
  /** Bridge a signal 1:1 into another interface (plan-257) — undefined hides the hover action. */
  onBridgeSignal?: (signalName: string) => void;
}) {
  const viewer = useViewer();
  const signalStore = viewer.signalStore ?? null;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Filter panel state (plan-234 §3.4 / F8): the permanent text field is gone;
  // text + facets live in a popover behind a filter trigger.
  const [filterState, setFilterState] = useState<SignalFilterState>(() => loadSignalFilter(iface.id));
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedGroups(iface.id));
  // Transient filter override only. Auto-expand never mutates the persisted user collapse state.
  const [filterAutoOpen, setFilterAutoOpen] = useState<Set<string>>(new Set());
  const [recordPending, setRecordPending] = useState<Set<string>>(new Set());
  const [recordError, setRecordError] = useState<string | null>(null);

  // Persist filter + collapsed groups per interface so they survive a browser reload.
  useEffect(() => { saveSignalFilter(iface.id, filterState); }, [iface.id, filterState]);
  useEffect(() => { saveCollapsedGroups(iface.id, collapsed); }, [iface.id, collapsed]);
  // NOTE (plan-344 Phase 1): there is deliberately NO list-level value tick here
  // any more. Subscribing to every signal of the interface and bumping a counter
  // re-rendered the ENTIRE component body (header chips, filter row, virtualizer,
  // ~30 wrapper Boxes with fresh `sx` literals) up to 60×/s. Value and activity
  // are now owned by the mounted virtual row (`SignalRowItem`), so only visible
  // rows react and this body re-renders on structural change only.
  // Coarse (200 ms) tick used ONLY to re-run the activity/connected facet
  // filtering — never on the 60-Hz value bus (§5.2 / §10-F). Static text/type
  // filtering ignores it entirely.
  const [filterTick, setFilterTick] = useState(0);
  // Feature flag (§10-H): OFF → exactly the previous rendering (no opacity/icons).
  const indicatorOn = useSignalActivityIndicator();

  const allSignals = useMemo(() => interfaceSignals(iface), [iface]);
  const overLimitSignalNames = useMemo(() => new Set(overLimitSignals), [overLimitSignals]);
  const hasTopics = (iface.topics?.length ?? 0) > 0;

  // Manual signal editing (gateway signal schema): add/edit/delete of interface-level (flat)
  // signals. Topic-nested ProcessImage signals stay import-only. `{ sig: null }` = add mode.
  const schema = getSignalSchema(iface.type);
  const [signalDialog, setSignalDialog] = useState<{ sig: ConnectInterfaceSignal | null } | null>(null);
  const handleEditSignal = useCallback((sig: ConnectInterfaceSignal) => setSignalDialog({ sig }), []);
  // Stable ref (memo rows): maps the row's signal to the parent's bridge-dialog opener.
  const handleBridgeSignal = useMemo(
    () => (onBridgeSignal ? (sig: ConnectInterfaceSignal) => onBridgeSignal(sig.name) : undefined),
    [onBridgeSignal]);
  // Signal delete confirms via the shared product dialog (same pattern as
  // interface and profile delete — one delete flow everywhere).
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const handleDeleteSignal = useCallback((sig: ConnectInterfaceSignal) => {
    setConfirmAction({
      title: `Delete signal '${sig.name}'?`,
      message: `Removes '${sig.name}' (${sig.protocolAddress}) from interface '${iface.id}'. This can't be undone.`,
      confirmLabel: 'Delete signal',
      onConfirm: () => removeSignal(iface.id, sig.name).catch((err) =>
        console.error('[ConnectPanel] Failed to delete signal:', err)),
    });
  }, [iface.id]);
  const manualEdit = !!schema?.supportsManualAdd;

  /** Patch flat and MQTT ProcessImage signals through their distinct CONNECT containers. */
  const handleRecordChange = useCallback(async (
    sig: ConnectInterfaceSignal,
    record: boolean,
    topic?: string,
  ) => {
    const key = `${topic ?? '__flat__'}\u0000${sig.name}\u0000${sig.protocolAddress}`;
    const sameSignal = (candidate: ConnectInterfaceSignal) =>
      candidate.name === sig.name && candidate.protocolAddress === sig.protocolAddress;
    setRecordPending((current) => new Set(current).add(key));
    setRecordError(null);
    try {
      if (topic !== undefined) {
        const topics = (iface.topics ?? []).map((entry) => entry.topic === topic
          ? { ...entry, signals: (entry.signals ?? []).map((candidate) => sameSignal(candidate) ? { ...candidate, record } : candidate) }
          : entry);
        await updateInterface(iface.id, { topics });
      } else {
        const signals = (iface.signals ?? []).map((candidate) => sameSignal(candidate) ? { ...candidate, record } : candidate);
        await updateInterface(iface.id, { signals });
      }
    } catch (error) {
      setRecordError(error instanceof Error ? error.message : String(error));
    } finally {
      setRecordPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, [iface]);

  // Facets that depend on live state (Active / Connected). Only when one of these
  // is engaged does the row list need periodic re-filtering.
  const activityFacetsActive = indicatorOn && filterNeedsActivity(filterState);

  // Drive a 200-ms filter tick ONLY while an activity/connected facet is active.
  // When the filter is purely static (text/type) or the indicator is off, no
  // interval runs and filtering re-evaluates only on filter-/data-change — so we
  // never re-filter hundreds/thousands of signals at 60 Hz (§5.2 performance rule).
  useEffect(() => {
    if (!activityFacetsActive) return;
    const id = window.setInterval(() => setFilterTick((t) => t + 1), 200);
    return () => window.clearInterval(id);
  }, [activityFacetsActive]);

  // Static signal→model coupling, resolved ONCE per signal name (bindings are
  // static per loaded model) — never per 60-Hz tick. Distinguishes the two
  // coupling mechanisms an operator must be able to tell apart:
  //   • auto   — a model component actually CONSUMES this signal (drives a
  //              cylinder / drive / sensor). Coupling is by SYMBOL NAME, not scene
  //              path. Two reference forms, both covered:
  //                – ComponentReference slot (`Drive_Cylinder.In` → the signal's
  //                  node), resolved back to the signal name via the reverse-ref
  //                  index (`getComponentReferencedSignalNames`), and
  //                – a plain string field holding the signal name
  //                  (`WebSensor.SignalBool = "..."`, via `getComponentsForSignal`).
  //              NOTE: mere EXISTENCE as a PLC node is deliberately NOT enough. The
  //              interface registers every process-image symbol in the store (and
  //              the GLB embeds ~300 signal nodes), so an "exists" test would count
  //              almost all 1300+ signals. Only signals a component references count.
  //   • manual — the user linked a placed element's slot to this signal in the
  //              Planner (`signalBindingManager.getLinkedSourceNames`).
  // `none` (not in `kind`) = a process-image symbol the model does not consume.
  // Auto wins over manual for classification; a manual link still shows its own
  // trailing LinkIcon. Live planner link edits refresh on the next model change.
  const binding = useMemo(() => {
    const kind = new Map<string, SignalBindingKind>();
    const reg = viewer.registry;
    const linked = viewer.signalBindingManager?.getLinkedSourceNames();
    // Signals referenced via ComponentReference slots — precise, resolved by name.
    const crefNames = reg && signalStore
      ? reg.getComponentReferencedSignalNames((p) => signalStore.nameForPath(p))
      : new Set<string>();
    let autoCount = 0;
    let manualCount = 0;
    for (const s of allSignals) {
      if (kind.has(s.name)) continue;
      // Consumed by a component = ComponentReference slot OR string-field reference.
      const usedByModel = crefNames.has(s.name)
        || (reg?.getComponentsForSignal(s.name).length ?? 0) > 0;
      if (usedByModel) {
        kind.set(s.name, 'auto');
        autoCount++;
      } else if (linked?.has(s.name)) {
        kind.set(s.name, 'manual');
        manualCount++;
      }
    }
    return { kind, autoCount, manualCount };
  }, [viewer, allSignals, signalStore]);

  const filterActive = isSignalFilterActive(filterState);

  // `key` is a TYPED collapse identity (`topic:…` / `tree:…`), never a bare topic name.
  const isGroupOpen = useCallback(
    (key: string) => !collapsed.has(key) || (filterActive && filterAutoOpen.has(key)),
    [collapsed, filterActive, filterAutoOpen],
  );

  const toggleGroup = useCallback((key: string) => {
    if (isGroupOpen(key)) {
      // Manual collapse removes any transient override and persists the user's intent.
      setFilterAutoOpen((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setCollapsed((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    } else {
      // Manual expand changes only the persisted user state.
      setCollapsed((prev) => {
        if (!prev.has(key)) return prev;
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [collapsed, filterAutoOpen, isGroupOpen]);

  const filteredSignals = useMemo(() => {
    // Static facets (text, type) are cheap and always evaluated. The time-variant
    // facets (active / connected) only run when engaged — and this useMemo is only
    // rescheduled for them via `filterTick` (200 ms), NEVER on the 60-Hz value bus.
    void filterTick;
    void filterActive;
    const needActivity = activityFacetsActive;
    const now = needActivity ? Date.now() : 0;
    const evalMode = needActivity ? getViewerMode() : 'standalone';

    const match = (s: ConnectInterfaceSignal): boolean => {
      // For static-only filters, skip the getActivity/isSourceConnected calls
      // entirely (they are the expensive, time-variant part).
      let activity: SignalActivity = 'local';
      let connected = false;
      if (needActivity && signalStore) {
        activity = signalStore.getActivity(s.name, now, evalMode);
        const source = signalStore.getSignalMeta(s.name)?.source;
        connected = source ? isSourceConnectedLive(source) : false;
      }
      return matchesSignalFilter(
        {
          name: s.name,
          protocolAddress: s.protocolAddress,
          plcTypeKind: plcTypeKind(s.type),
          activity,
          connected,
          // Static coupling kind (auto / manual / none) — cheap Map lookup, no
          // per-tick work, so it is evaluated for every filter (not gated on needActivity).
          binding: binding.kind.get(s.name) ?? 'none',
          recorded: s.record === true,
        },
        filterState,
      );
    };

    const filteredTopicSignals = new Map<string, ConnectInterfaceSignal[]>();
    for (const topic of iface.topics ?? []) {
      filteredTopicSignals.set(topic.topic, (topic.signals ?? []).filter(match));
    }
    const filteredFlatSignals = (iface.signals ?? []).filter(match);
    return { filteredTopicSignals, filteredFlatSignals };
  }, [iface, filterState, filterActive, activityFacetsActive, filterTick, signalStore, binding]);

  const { filteredTopicSignals, filteredFlatSignals } = filteredSignals;

  // Derived MQTT topic tree over the FLAT signals (plan-352 F1). Built once from the UNFILTERED
  // list so node identity — and with it the collapse state — is stable while the filter changes;
  // pruning happens at flatten time. Only MQTT interfaces get a tree; every other protocol keeps
  // the previous flat rendering, and addresses without `/` stay top-level leaves.
  const flatTree = useMemo<ReadonlyArray<TopicTreeEntry<ConnectInterfaceSignal>> | null>(() => {
    if (iface.type !== 'MQTT') return null;
    const flat = iface.signals ?? [];
    if (flat.length === 0) return null;
    if (!flat.some(s => s.protocolAddress.includes('/'))) return null;
    return buildTopicTree(flat, s => s.protocolAddress);
  }, [iface]);

  // Cheap group-level derivation from the shared signal filter pass. Never re-evaluate matches here.
  // Keys are typed; for a matching tree LEAF every ancestor level is added, so the filter opens the
  // whole path down to the hit (F4) instead of only its direct parent.
  const matchedTopics = useMemo(() => {
    const matches = new Set<string>();
    if (!filterActive) return matches;
    for (const [topic, signals] of filteredTopicSignals) {
      if (signals.length > 0) matches.add(topicKey(topic));
    }
    if (flatTree) {
      for (const s of filteredFlatSignals) {
        for (const path of ancestorPathsOf(s.protocolAddress)) matches.add(treeKey(path));
      }
    }
    return matches;
  }, [filteredTopicSignals, filteredFlatSignals, flatTree, filterActive]);

  const prevMatchesRef = useRef<Set<string> | null>(null);
  const prevCriteriaRef = useRef<SignalFilterState | null>(null);

  useEffect(() => {
    if (!filterActive) {
      prevMatchesRef.current = null;
      prevCriteriaRef.current = null;
      // State hygiene only: the filterActive gate already makes the override invisible this render.
      setFilterAutoOpen((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }

    const criteriaChanged = prevCriteriaRef.current !== filterState;
    const prevMatches = prevMatchesRef.current;
    prevMatchesRef.current = matchedTopics;
    prevCriteriaRef.current = filterState;
    setFilterAutoOpen((existing) =>
      computeFilterAutoOpen(existing, prevMatches, matchedTopics, criteriaChanged));
  }, [filterActive, filterState, matchedTopics]);

  const rows = useMemo<SignalListRow[]>(() => {
    const out: SignalListRow[] = [];
    // Pass 1 — configured topic entries (ProcessImage AND Single) stay single-level groups (F5).
    for (const t of iface.topics ?? []) {
      const sigs = filteredTopicSignals.get(t.topic) ?? [];
      if (filterActive && sigs.length === 0) continue;   // hide empty groups while filtering
      out.push({ kind: 'group', topic: t.topic, total: t.signals?.length ?? 0 });
      const open = isGroupOpen(topicKey(t.topic));
      if (open) for (const s of sigs) out.push({ kind: 'signal', sig: s, topic: t.topic });
    }
    // Pass 2 — flat (interface-level) signals: the manually editable ones. For MQTT they are
    // emitted as the derived topic tree; every other protocol keeps the plain flat list.
    if (flatTree) {
      const visible = filterActive ? new Set(filteredFlatSignals) : null;
      const treeRows = flattenTopicTree(flatTree, {
        isOpen: (path) => isGroupOpen(treeKey(path)),
        isLeafVisible: visible ? (s) => visible.has(s) : undefined,
      });
      for (const r of treeRows) {
        out.push(r.kind === 'node'
          ? { kind: 'treeNode', path: r.path, label: r.label, depth: r.depth, count: r.count }
          : { kind: 'signal', sig: r.item, flat: true, depth: r.depth });
      }
    } else {
      for (const s of filteredFlatSignals) out.push({ kind: 'signal', sig: s, flat: true });
    }
    return out;
  }, [iface, filteredTopicSignals, filteredFlatSignals, filterActive, isGroupOpen, flatTree]);

  // ── Multi-selection over signals (bulk delete) ───────────────────────────
  // No checkboxes: plain click selects, Ctrl/Meta toggles, Shift spans a range. Shift+CLICK is
  // free to mean "range" because the row's Shift+DRAG only promotes to a drag past
  // SIGNAL_DRAG_THRESHOLD_PX — a stationary Shift+click never starts one. The trailing click of a
  // real drag is suppressed by the drag store and consumed here before it can alter the selection.
  const [selectedSignals, setSelectedSignals] = useState<ReadonlySet<string>>(() => new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const [signalMenu, setSignalMenu] = useState<{ x: number; y: number; sig: ConnectInterfaceSignal } | null>(null);

  // Rendered order is what a range walks; keep it in a ref so the click handler stays stable and
  // the memoized rows do not re-render on every selection change.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // Drop keys the list no longer offers (delete, discovery, interface switch) so a bulk delete can
  // never act on a phantom. Same-instance return keeps this a no-op when nothing changed. The key
  // set spans BOTH containers — flat signals and every topic's signals.
  const liveSelectionKeys = useMemo(() => {
    const keys = (iface.signals ?? []).map(s => selectionKey(undefined, s.name));
    for (const t of iface.topics ?? []) {
      for (const s of t.signals ?? []) keys.push(selectionKey(t.topic, s.name));
    }
    return keys;
  }, [iface.signals, iface.topics]);
  const liveKeySig = liveSelectionKeys.length;
  useEffect(() => {
    setSelectedSignals((current) => pruneSelection(current, liveSelectionKeys) as ReadonlySet<string>);
    // Re-pruning on every store poll would be O(all signals) at poll rate; the count is a cheap
    // proxy for "the list actually changed", which is the only case that can orphan a key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKeySig]);

  // Current selection + anchor in refs: the click handler must read them without becoming a new
  // function on every selection change (that would re-render every memoized row), and the two
  // state updates must happen SIDE BY SIDE. Setting the anchor from inside the selection updater
  // would be a side effect in a reducer — React may run it twice and drop the nested update.
  const selectedRef = useRef(selectedSignals);
  selectedRef.current = selectedSignals;
  const anchorRef = useRef(selectionAnchor);
  anchorRef.current = selectionAnchor;

  const handleSignalSelect = useCallback((
    sig: ConnectInterfaceSignal, e: React.MouseEvent, topic?: string,
  ) => {
    // A completed Shift+drag ends in a click on this row — that must not move the selection.
    if (consumeSignalDragClick()) return;
    const result = applySelection(
      rowsRef.current, selectedRef.current, anchorRef.current,
      selectionKey(topic, sig.name), selectionIntent(e));
    setSelectedSignals(result.selected);
    setSelectionAnchor(result.anchor);
  }, []);

  // Right-click / long-press entry point. Opening the menu on a row OUTSIDE the current selection
  // reduces the selection to that row, so the confirm dialog can never name a count the user did
  // not mean to act on.
  const handleSignalContextMenu = useCallback((
    sig: ConnectInterfaceSignal, x: number, y: number, topic?: string,
  ) => {
    const key = selectionKey(topic, sig.name);
    if (!selectedRef.current.has(key)) {
      setSelectedSignals(new Set([key]));
      setSelectionAnchor(key);
    }
    setSignalMenu({ x, y, sig });
  }, []);

  /**
   * Delete every selected signal in ONE config write, across both containers.
   *
   * Deliberately not a loop over removeSignal(): N sequential REST round-trips would leave the
   * interface half-deleted if one fails midway, and each rewrites the whole config anyway. Flat
   * signals and topic-nested ProcessImage signals live in separate arrays, so both are patched in
   * the same request.
   *
   * Deleting inside a ProcessImage topic leaves the remaining byte offsets untouched — the image
   * keeps its holes. That is intentional: offsets come from the imported tag table and silently
   * repacking them would decode every following signal at the wrong address.
   */
  const handleBulkDelete = useCallback((keys: ReadonlySet<string>) => {
    const count = keys.size;
    const { flat, byTopic } = groupKeysByTopic(keys);
    const only = count === 1 ? [...keys].map(k => k.slice(k.indexOf(' ') + 1))[0] : null;
    const nested = count - flat.size;
    setConfirmAction({
      title: only ? `Delete signal '${only}'?` : `Delete ${count} signals?`,
      message: only
        ? `Removes '${only}' from interface '${iface.id}'. This can't be undone.`
        : `Removes ${count} selected signals from interface '${iface.id}'`
          + (nested > 0
            ? `, ${nested} of them from imported process-image topics — the remaining byte offsets stay as they are.`
            : '.')
          + " This can't be undone.",
      confirmLabel: only ? 'Delete signal' : `Delete ${count} signals`,
      onConfirm: () => {
        const patch: { signals?: ConnectInterfaceSignal[]; topics?: ConnectInterface['topics'] } = {};
        if (flat.size > 0) patch.signals = (iface.signals ?? []).filter(s => !flat.has(s.name));
        if (byTopic.size > 0) {
          patch.topics = (iface.topics ?? []).map((entry) => {
            const drop = byTopic.get(entry.topic);
            return drop
              ? { ...entry, signals: (entry.signals ?? []).filter(s => !drop.has(s.name)) }
              : entry;
          });
        }
        return updateInterface(iface.id, patch)
          .then(() => { setSelectedSignals(new Set()); setSelectionAnchor(null); })
          .catch((err) => console.error('[ConnectPanel] Failed to delete signals:', err));
      },
    });
  }, [iface]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Group AND tree-node rows share GROUP_ROW_HEIGHT — the virtualizer's height assumption must
    // hold for every non-signal row.
    estimateSize: (i) => (rows[i].kind === 'signal' ? SIGNAL_ROW_HEIGHT : GROUP_ROW_HEIGHT),
    overscan: 12,
  });

  // Scroll-offset persistence (plan-344 Phase 3.4). Closing the ConnectPanel
  // unmounts this view including the scroll container, so without this the list
  // silently jumped back to the top on every reopen while filter and collapse
  // state were restored — an inconsistency the user reads as a bug.
  // Restore once per interface, after the virtualizer has laid out its rows.
  const scrollRestoredRef = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || scrollRestoredRef.current === iface.id) return;
    scrollRestoredRef.current = iface.id;
    const offset = loadSignalScroll(iface.id);
    if (offset > 0) el.scrollTop = offset;
  }, [iface.id, rows.length]);

  const handleListScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => saveSignalScroll(iface.id, e.currentTarget.scrollTop),
    [iface.id],
  );

  // CONNECT signals linked to model components (planner signal linking) → node path
  // + slot per source. The manager rebuilds the full Map and all row arrays on every
  // call, so keep it on the same structural/model-change cadence as `binding` above
  // instead of repeating it on the 200-ms live-value render tick.
  const linksBySource = useMemo(
    () => viewer.signalBindingManager?.getLinksForSource() ?? EMPTY_LINKS,
    [viewer, allSignals, signalStore],
  );

  const facetCount = activeFilterCount(filterState);
  const toggleType = useCallback((k: PlcTypeKind) => {
    setFilterState((prev) => {
      const types = new Set(prev.types);
      if (types.has(k)) types.delete(k); else types.add(k);
      return { ...prev, types };
    });
  }, []);
  const resetFilter = useCallback(() => setFilterState(emptySignalFilterState()), []);

  // Historian overview: how many signals of this interface carry the Record flag.
  // Rendered as a header counter (same vocabulary as Auto/Linked) that toggles the
  // `recorded` facet — one glance answers "what are we actually recording?".
  const recordedCount = useMemo(() => {
    let n = 0;
    for (const t of iface.topics ?? []) for (const s of t.signals ?? []) if (s.record === true) n++;
    for (const s of iface.signals ?? []) if (s.record === true) n++;
    return n;
  }, [iface]);

  // Model-coupling counter chip (Auto / Linked): shows how many signals of this
  // interface actually reach the model, split by coupling kind, and toggles the
  // matching `binding` filter on click. Makes both mechanisms visible at a glance.
  const couplingCounter = (
    kind: 'auto' | 'manual',
    Icon: typeof Hub,
    count: number,
    tip: string,
  ) => {
    const on = filterState.binding === kind;
    return (
      <Tooltip title={tip}>
        <Box
          onClick={() => setFilterState((p) => ({ ...p, binding: p.binding === kind ? 'all' : kind }))}
          sx={{
            display: 'flex', alignItems: 'center', gap: 0.25, cursor: 'pointer',
            px: 0.5, py: 0.1, borderRadius: 0.75, flexShrink: 0,
            bgcolor: on ? 'rgba(79,195,247,0.20)' : 'transparent',
            '&:hover': { bgcolor: 'rgba(79,195,247,0.10)' },
          }}
        >
          <Icon sx={{ fontSize: 12, color: on ? '#4fc3f7' : 'rgba(255,255,255,0.6)' }} />
          <Typography sx={{ fontSize: 10, color: on ? '#4fc3f7' : 'rgba(255,255,255,0.7)', lineHeight: 1, fontFamily: 'monospace' }}>
            {count}
          </Typography>
        </Box>
      </Tooltip>
    );
  };

  return (
    // flex-basis auto (not 0%): the wrapper is content-sized with a maxHeight cap,
    // so this list must contribute its natural height — basis 0% would collapse it.
    // minHeight 0 keeps it shrinkable when the wrapper's cap kicks in.
    <Box sx={{ px: 1, pb: 1, flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Header: model-coupling counters (Auto / Linked) on the left, filter trigger
          (with active-facet badge) + activity indicator toggle on the right. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5, flexShrink: 0 }}>
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
          {couplingCounter(
            'auto', Hub, binding.autoCount,
            `${binding.autoCount} signal(s) used by a model component (drive / cylinder / sensor), coupled by signal name. Click to show only these.`,
          )}
          {(viewer.signalBindingManager || binding.manualCount > 0) && couplingCounter(
            'manual', LinkIcon, binding.manualCount,
            `${binding.manualCount} signal(s) manually linked to a placed element in the Planner. Click to show only these.`,
          )}
          {recordedCount > 0 && (
            <Tooltip title={`${recordedCount} signal(s) recorded in the historian. Click to show only these.`}>
              <Box
                onClick={() => setFilterState((p) => ({ ...p, recorded: p.recorded === 'recorded' ? 'all' : 'recorded' }))}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 0.25, cursor: 'pointer',
                  px: 0.5, py: 0.1, borderRadius: 0.75, flexShrink: 0,
                  bgcolor: filterState.recorded === 'recorded' ? 'rgba(79,195,247,0.20)' : 'transparent',
                  '&:hover': { bgcolor: 'rgba(79,195,247,0.10)' },
                }}
              >
                <FiberManualRecord sx={{ fontSize: 10, color: filterState.recorded === 'recorded' ? '#4fc3f7' : 'rgba(255,255,255,0.6)' }} />
                <Typography sx={{ fontSize: 10, color: filterState.recorded === 'recorded' ? '#4fc3f7' : 'rgba(255,255,255,0.7)', lineHeight: 1, fontFamily: 'monospace' }}>
                  {recordedCount}
                </Typography>
              </Box>
            </Tooltip>
          )}
        </Box>
        {manualEdit && (
          <Tooltip title={`Add signal manually (${schema?.addressLabel ?? 'address'} + name)`}>
            <IconButton
              size="small"
              aria-label="Add signal"
              onClick={() => setSignalDialog({ sig: null })}
              sx={{ color: 'rgba(255,255,255,0.6)', flexShrink: 0 }}
            >
              <Add sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title="Filter signals">
          <IconButton
            size="small"
            aria-label={facetCount > 0 ? `Filter signals (${facetCount} active)` : 'Filter signals'}
            onClick={(e) => setFilterAnchor(e.currentTarget)}
            sx={{ color: facetCount > 0 ? ISA_GREEN : 'rgba(255,255,255,0.6)', flexShrink: 0 }}
          >
            <Badge
              badgeContent={facetCount}
              color="primary"
              sx={{ '& .MuiBadge-badge': { fontSize: 8, height: 13, minWidth: 13 } }}
            >
              <FilterList sx={{ fontSize: 16 }} />
            </Badge>
          </IconButton>
        </Tooltip>
        <Tooltip title={indicatorOn ? 'Hide active/stale indicators' : 'Show active/stale indicators'}>
          <IconButton
            size="small"
            aria-label={indicatorOn ? 'Hide active/stale indicators' : 'Show active/stale indicators'}
            onClick={() => setSignalActivityIndicator(!indicatorOn)}
            sx={{ color: indicatorOn ? ISA_GREEN : 'rgba(255,255,255,0.45)', flexShrink: 0 }}
          >
            <Sensors sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      </Box>

      <SignalFilterPopover
        anchorEl={filterAnchor}
        onClose={() => setFilterAnchor(null)}
        filterState={filterState}
        setFilterState={setFilterState}
        toggleType={toggleType}
        onReset={resetFilter}
      />

      <Box
        ref={scrollRef}
        className={RV_SCROLL_CLASS}
        onScroll={handleListScroll}
        // basis auto: contributes the virtualized total height so the expanded
        // wrapper can content-size; shrinks (and scrolls) when the cap applies.
        sx={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', position: 'relative' }}
      >
        {rows.length === 0 ? (
          <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', textAlign: 'center', py: 2, px: 1 }}>
            {filterActive
              ? 'No signals match the filter.'
              : 'No signals yet — use Browse or Import on this interface to add some.'}
          </Typography>
        ) : (
          <Box sx={{ height: rowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
            {rowVirtualizer.getVirtualItems().map((vRow) => {
              const row = rows[vRow.index];
              const base = {
                position: 'absolute' as const,
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vRow.start}px)`,
                display: 'flex',
                alignItems: 'center',
              };

              if (row.kind === 'group') {
                const open = isGroupOpen(topicKey(row.topic));
                return (
                  <Box
                    key={vRow.key}
                    onClick={() => toggleGroup(topicKey(row.topic))}
                    sx={{ ...base, height: GROUP_ROW_HEIGHT, gap: 0.25, px: 0.25, cursor: 'pointer', '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' } }}
                  >
                    {open ? <ExpandLess sx={{ fontSize: 13 }} /> : <ExpandMore sx={{ fontSize: 13 }} />}
                    <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.topic}
                    </Typography>
                    <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', fontFamily: 'monospace' }}>{row.total}</Typography>
                  </Box>
                );
              }

              // Derived MQTT topic level — same row as a topic group plus depth indentation, so the
              // virtualizer keeps one height for every non-signal row.
              if (row.kind === 'treeNode') {
                const open = isGroupOpen(treeKey(row.path));
                return (
                  <Box
                    key={vRow.key}
                    data-rv-depth={row.depth}
                    onClick={() => toggleGroup(treeKey(row.path))}
                    sx={{ ...base, height: GROUP_ROW_HEIGHT, gap: 0.25, pr: 0.25, pl: 0.25 + row.depth, cursor: 'pointer', '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' } }}
                  >
                    {open ? <ExpandLess sx={{ fontSize: 13 }} /> : <ExpandMore sx={{ fontSize: 13 }} />}
                    <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.label}
                    </Typography>
                    <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', fontFamily: 'monospace' }}>{row.count}</Typography>
                  </Box>
                );
              }

              const sig = row.sig;
              const plcType = sig.type;
              const direction: 'input' | 'output' = plcType.startsWith('PLCOutput') ? 'output' : 'input';
              // Leading "in model" icon when a model signal shares this symbol name
              // (auto coupling). No icon otherwise (manual links show the trailing
              // LinkIcon instead; pure interface symbols show neither).
              const inModel = binding.kind.get(sig.name) === 'auto';
              // Live value and activity are NOT derived here any more (plan-344
              // Phase 1) — the row owns both, so this body stays off the value bus.
              // Linked target(s): nearest owner's leaf name · slot (+N), plus the
              // path to navigate to on click. Undefined when the signal is unlinked.
              const links = linksBySource.get(sig.name);
              const firstLink = links?.[0];
              const linkedLabel = firstLink
                ? `${firstLink.path.split('/').filter(Boolean).pop() ?? firstLink.path} · ${firstLink.slot}${links!.length > 1 ? ` (+${links!.length - 1})` : ''}`
                : undefined;
              return (
                <Box
                  key={vRow.key}
                  sx={{ ...base, height: SIGNAL_ROW_HEIGHT }}
                >
                  <SignalRowItem
                    sig={sig}
                    direction={direction}
                    plcType={plcType}
                    inModel={inModel}
                    hasTopics={hasTopics}
                    depth={row.depth}
                    viewer={viewer}
                    indicatorOn={indicatorOn}
                    linkedLabel={linkedLabel}
                    linkedPath={firstLink?.path}
                    onEdit={manualEdit && row.flat ? handleEditSignal : undefined}
                    onDelete={manualEdit && row.flat ? handleDeleteSignal : undefined}
                    selected={selectedSignals.has(selectionKey(row.topic, sig.name))}
                    onSelect={manualEdit ? handleSignalSelect : undefined}
                    onContextMenu={manualEdit ? handleSignalContextMenu : undefined}
                    onBridge={handleBridgeSignal}
                    onRecordChange={handleRecordChange}
                    topic={row.topic}
                    interfaceId={iface.id}
                    recordPending={recordPending.has(`${row.topic ?? '__flat__'}\u0000${sig.name}\u0000${sig.protocolAddress}`)}
                    limitExceeded={overLimitSignalNames.has(sig.name)}
                  />
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* Manual add/edit-signal dialog (generic — rendered from the gateway's per-type schema). */}
      {signalDialog && (
        <SignalEditDialog
          open
          onClose={() => setSignalDialog(null)}
          iface={iface}
          schema={schema}
          editSignal={signalDialog.sig}
          isBound={signalDialog.sig ? binding.kind.has(signalDialog.sig.name) : false}
        />
      )}

      <Snackbar open={recordError !== null} autoHideDuration={6000} onClose={() => setRecordError(null)}>
        <Alert severity="error" variant="filled" onClose={() => setRecordError(null)}>
          Historian recording could not be updated: {recordError}
        </Alert>
      </Snackbar>

      {/* Row action menu — right-click on the desktop, long-press on touch. Anchored to the
          pointer, not to the row, so it also works for a long-press in a virtualized list. */}
      <Menu
        open={signalMenu !== null}
        onClose={() => setSignalMenu(null)}
        anchorReference="anchorPosition"
        anchorPosition={signalMenu ? { top: signalMenu.y, left: signalMenu.x } : undefined}
        slotProps={{ list: { dense: true, sx: { py: 0.5 } } }}
      >
        <MenuItem
          sx={{ fontSize: 12, gap: 1, color: ISA_RED }}
          onClick={() => {
            // handleSignalContextMenu already guarantees the clicked row is IN the selection, so
            // the current selection is exactly what the menu label promised.
            const keys = selectedSignals;
            setSignalMenu(null);
            if (keys.size > 0) handleBulkDelete(keys);
          }}
        >
          <Delete sx={{ fontSize: 14 }} />
          {selectedSignals.size > 1 ? `Delete ${selectedSignals.size} signals…` : 'Delete signal…'}
        </MenuItem>
        {selectedSignals.size > 1 && (
          <MenuItem
            sx={{ fontSize: 12, gap: 1 }}
            onClick={() => { setSignalMenu(null); setSelectedSignals(new Set()); setSelectionAnchor(null); }}
          >
            Clear selection ({selectedSignals.size})
          </MenuItem>
        )}
      </Menu>

      {/* Signal-delete confirmation. */}
      <ConfirmActionDialog action={confirmAction} onClose={() => setConfirmAction(null)} />
    </Box>
  );
}

// ── Browse Window (discovery results + add to interface signals) ──────────

export interface SignalBudgetGate {
  /** Selected signals whose name is not yet admitted — what the bind would actually consume. */
  newSignals: number;
  /** Remaining slots, or null when the budget is unknown or unlimited (then nothing is gated). */
  free: number | null;
  /** True when the bind would be rejected wholesale by the gateway. */
  overBudget: boolean;
  limit: number | null;
}

/**
 * Decide whether a bind fits the licensed signal budget, BEFORE it is sent.
 *
 * The gateway admits a discovery bind all-or-nothing (`SignalStore.TryAdmitSignals`): selecting
 * 27 signals against 20 free binds zero, not the first 20. Letting the operator press a button
 * that can only fail is the actual defect, so the count is derived here from the same inputs the
 * gateway uses — already-configured names (which are already admitted, hence free) and the
 * license budget. An unknown or unlimited budget gates nothing; the gateway stays the authority.
 */
export function signalBudgetGate(
  status: LicenseStatus | null,
  selectedNames: readonly string[],
  configuredNames: ReadonlySet<string>,
): SignalBudgetGate {
  const newSignals = selectedNames.filter(name => !configuredNames.has(name)).length;
  const budgeted = status !== null
    && status.maxSignals > 0
    && status.maxSignals < UNLIMITED_SIGNAL_LIMIT;
  if (!budgeted) return { newSignals, free: null, overBudget: false, limit: null };

  const free = Math.max(0, status.maxSignals - status.admittedSignals);
  return { newSignals, free, overBudget: newSignals > free, limit: status.maxSignals };
}

/** Floating window showing discovery results; selected signals can be added to the interface. */
function BrowseWindow({ open, onClose }: { open: boolean; onClose: () => void }) {
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const licenseSnap = useSyncExternalStore(subscribeLicenseStore, getLicenseSnapshot);
  const iface = snap.interfaces.find(i => i.id === snap.activeInterfaceId) ?? null;
  const selectedCount = snap.discoveredSignals.filter(s => s.selected).length;
  const [addError, setAddError] = useState<string | null>(null);

  // Names already configured anywhere are already admitted — re-selecting them costs no slot.
  const configuredNames = useMemo(
    () => new Set(snap.interfaces.flatMap(i => i.signals?.map(s => s.name) ?? [])),
    [snap.interfaces],
  );
  const gate = useMemo(
    () => signalBudgetGate(
      licenseSnap.status,
      snap.discoveredSignals.filter(s => s.selected).map(s => discoveredSignalName(s.displayName)),
      configuredNames,
    ),
    [licenseSnap.status, snap.discoveredSignals, configuredNames],
  );

  const handleAdd = useCallback(async () => {
    if (!snap.activeInterfaceId || selectedCount === 0) return;
    setAddError(null);
    try {
      await bindSelectedSignals(snap.activeInterfaceId);
    } catch (err) {
      // Without this the rejection surfaced only as an uncaught promise in the console and the
      // window sat there looking like nothing had happened.
      setAddError(err instanceof Error ? err.message : String(err));
      return;
    }
    onClose();
  }, [snap.activeInterfaceId, selectedCount, onClose]);

  return (
    <FloatingPanel
      open={open}
      onClose={onClose}
      title={`Browse${iface ? ` — ${iface.type}` : ''}`}
      panelId="connect-browse"
      defaultWidth={440}
      defaultHeight={460}
    >
      <Box sx={{ p: 1, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {snap.discoveryLoading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        )}

        {!snap.discoveryLoading && snap.discoveredSignals.length === 0 && (
          <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', textAlign: 'center', py: 2, px: 1 }}>
            No signals discovered — check that the interface is enabled and its source is reachable.
          </Typography>
        )}

        {!snap.discoveryLoading && snap.discoveredSignals.length > 0 && (
          <>
            <Box sx={{ display: 'flex', gap: 0.5, mb: 0.5, flexShrink: 0 }}>
              <Button size="small" startIcon={<SelectAll sx={{ fontSize: 12 }} />} onClick={() => selectAllSignals(true)} sx={{ fontSize: 9, textTransform: 'none', minWidth: 0 }}>All</Button>
              <Button size="small" startIcon={<Deselect sx={{ fontSize: 12 }} />} onClick={() => selectAllSignals(false)} sx={{ fontSize: 9, textTransform: 'none', minWidth: 0 }}>None</Button>
            </Box>

            <Box className={RV_SCROLL_CLASS} sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              {snap.discoveredSignals.map((sig) => (
                <Box key={sig.protocolAddress} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.25, '&:hover': { bgcolor: 'rgba(79,195,247,0.06)' } }}>
                  <Checkbox size="small" checked={sig.selected ?? false} onChange={() => toggleSignalSelection(sig.protocolAddress)} sx={{ p: 0.25, '& .MuiSvgIcon-root': { fontSize: 14 } }} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sig.displayName}</Typography>
                    <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: 'monospace' }}>{sig.protocolAddress}</Typography>
                  </Box>
                  <Chip label={sig.dataType} size="small" sx={{ fontSize: 9, height: 16, '& .MuiChip-label': { px: 0.5 } }} />
                  <Chip label={sig.direction} size="small" color={sig.direction === 'input' ? 'info' : sig.direction === 'output' ? 'success' : 'default'} sx={{ fontSize: 9, height: 16, '& .MuiChip-label': { px: 0.5 } }} />
                </Box>
              ))}
            </Box>

            {gate.overBudget && (
              <Typography sx={{ mt: 1, flexShrink: 0, fontSize: 10, color: ISA_AMBER }}>
                Signal limit: {gate.newSignals} new signals selected, only {gate.free} of {gate.limit} free.
                Deselect {gate.newSignals - (gate.free ?? 0)} or activate a license.
              </Typography>
            )}

            {addError && (
              <Typography sx={{ mt: 1, flexShrink: 0, fontSize: 10, color: ISA_RED }}>
                {addError}
              </Typography>
            )}

            <Button variant="contained" size="small" startIcon={<Add sx={{ fontSize: 14 }} />} onClick={handleAdd} disabled={selectedCount === 0 || gate.overBudget} sx={{ mt: 1, flexShrink: 0, fontSize: 10, textTransform: 'none', width: '100%' }}>
              Add to signals ({selectedCount})
            </Button>
          </>
        )}
      </Box>
    </FloatingPanel>
  );
}

// ── Connect Log Window (polls /logs, level filter, auto-scroll) ───────────

const LOG_POLL_MS = 1000;
const LOG_MAX_ROWS = 2000;
// The dialog is a FloatingPanel (zIndex 1500); MUI menus portal to body at zIndex 1300 and
// would open BEHIND the panel without an explicit bump.
const LOG_MENU_Z = 2000;

/** Color a log line by its level — state colors for abnormal levels, ink for the rest
 *  (Instrument Blue stays reserved for actionable/selected elements). */
function logLevelColor(level: string): string {
  const l = level.toLowerCase();
  if (l === 'error' || l === 'critical') return ISA_RED;
  if (l === 'warning' || l === 'warn') return ISA_AMBER;
  if (l === 'information' || l === 'info') return 'rgba(255,255,255,0.75)';
  if (l === 'debug' || l === 'trace') return 'rgba(255,255,255,0.5)';
  return 'rgba(255,255,255,0.55)';
}

/** Canonical short level tag ("DBG"/"INF"/"WRN"/"ERR") — never a truncation artifact like "DEBU". */
function logLevelShort(level: string): string {
  const l = level.toLowerCase();
  if (l === 'critical') return 'CRIT';
  if (l === 'error') return 'ERR';
  if (l === 'warning' || l === 'warn') return 'WRN';
  if (l === 'information' || l === 'info') return 'INF';
  if (l === 'debug') return 'DBG';
  if (l === 'trace') return 'TRC';
  return level.slice(0, 4).toUpperCase();
}

/** Short HH:MM:SS from an ISO timestamp (gateway logs are UTC ISO strings). */
function logTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}

/** Serialize log entries to plain text for the clipboard (one line per entry). */
function logEntriesToText(entries: ConnectLogEntry[]): string {
  return entries
    .map((e) => {
      const iface = e.iface ? ` [${e.iface}]` : '';
      return `${e.time} ${e.level.toUpperCase()}${iface} ${e.category}: ${e.message}`;
    })
    .join('\n');
}

/**
 * Log window. Opens as a modal dialog and tails CONNECT's /logs endpoint incrementally
 * (via the `latest` sequence number) with level + interface filtering, pause, clear,
 * copy-to-clipboard, and auto-scroll.
 */
function ConnectLogDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<ConnectLogEntry[]>([]);
  const [level, setLevel] = useState<string>('Debug');
  const [iface, setIface] = useState<string>('');
  const [ifaces, setIfaces] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const sinceRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);

  // Re-query from scratch when the window (re)opens or a filter changes.
  useEffect(() => {
    if (!open) return;
    sinceRef.current = 0;
    setEntries([]);
  }, [open, level, iface]);

  useEffect(() => {
    if (!open || paused) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const { latest, interfaces, entries: fresh } = await fetchLogs(
          sinceRef.current, 500, level || undefined, iface || undefined);
        if (cancelled) return;
        const wasInitial = sinceRef.current === 0;
        sinceRef.current = latest;
        if (interfaces) setIfaces(interfaces);
        if (fresh.length === 0) return;
        setEntries(prev => {
          const merged = wasInitial ? fresh : [...prev, ...fresh];
          return merged.length > LOG_MAX_ROWS ? merged.slice(merged.length - LOG_MAX_ROWS) : merged;
        });
      } catch {
        // Gateway unreachable — keep the last entries, retry on next tick.
      }
    };
    poll();
    const id = setInterval(poll, LOG_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [open, paused, level, iface]);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(logEntriesToText(entries)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable (insecure context) — ignore */ });
  }, [entries]);

  // Auto-scroll to the newest line unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  // Controls live in the FloatingPanel title bar; stop mousedown so using them never drags the window.
  const toolbar = (
    <Box onMouseDown={(e) => e.stopPropagation()} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <FormControl size="small" variant="standard">
        <Select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          disableUnderline
          inputProps={{ 'aria-label': 'Minimum log level' }}
          sx={{ fontSize: 11, '& .MuiSelect-select': { py: 0.25 } }}
          MenuProps={{ sx: { zIndex: LOG_MENU_Z } }}
        >
          <MenuItem value="Debug" sx={{ fontSize: 12 }}>Debug</MenuItem>
          <MenuItem value="Warning" sx={{ fontSize: 12 }}>Warning</MenuItem>
          <MenuItem value="Error" sx={{ fontSize: 12 }}>Error</MenuItem>
        </Select>
      </FormControl>
      <FormControl size="small" variant="standard" sx={{ maxWidth: 160 }}>
        <Select
          value={iface}
          onChange={(e) => setIface(e.target.value)}
          displayEmpty
          disableUnderline
          inputProps={{ 'aria-label': 'Filter log by interface' }}
          sx={{ fontSize: 11, '& .MuiSelect-select': { py: 0.25 } }}
          MenuProps={{ sx: { zIndex: LOG_MENU_Z } }}
        >
          <MenuItem value="" sx={{ fontSize: 12 }}>All interfaces</MenuItem>
          {ifaces.map((name) => (
            <MenuItem key={name} value={name} sx={{ fontSize: 12 }}>{name}</MenuItem>
          ))}
        </Select>
      </FormControl>
      <Tooltip title={copied ? 'Copied' : 'Copy log to clipboard'}>
        <span>
          <IconButton size="small" aria-label="Copy log to clipboard" onClick={handleCopy} disabled={entries.length === 0} sx={{ p: 0.3 }}>
            {copied ? <Check sx={{ fontSize: 16, color: ISA_GREEN }} /> : <ContentCopy sx={{ fontSize: 16 }} />}
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title={paused ? 'Resume' : 'Pause'}>
        <IconButton size="small" aria-label={paused ? 'Resume log tail' : 'Pause log tail'} onClick={() => setPaused(p => !p)} sx={{ p: 0.3 }}>
          {paused ? <PlayArrow sx={{ fontSize: 16 }} /> : <Pause sx={{ fontSize: 16 }} />}
        </IconButton>
      </Tooltip>
      <Tooltip title="Clear view">
        <IconButton size="small" aria-label="Clear log view" onClick={() => setEntries([])} sx={{ p: 0.3 }}>
          <ClearAll sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
    </Box>
  );

  return (
    <FloatingPanel
      open={open}
      onClose={onClose}
      title="Log"
      panelId="connect-log"
      defaultWidth={640}
      defaultHeight={360}
      toolbar={toolbar}
    >
      <Box
        ref={scrollRef}
        onScroll={handleScroll}
        className={RV_SCROLL_CLASS}
        sx={{ flex: 1, minHeight: 0, overflow: 'auto', bgcolor: 'rgba(0,0,0,0.3)', p: 1, fontFamily: 'monospace' }}
      >
          {entries.length === 0 ? (
            <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', textAlign: 'center', py: 3 }}>
              {paused ? 'Paused.' : 'No log entries.'}
            </Typography>
          ) : (
            entries.map((e) => (
              <Box key={e.seq} sx={{ display: 'flex', gap: 0.75, alignItems: 'baseline', py: 0.1 }}>
                <Typography component="span" sx={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', fontFamily: 'monospace', flexShrink: 0 }}>
                  {logTime(e.time)}
                </Typography>
                <Typography component="span" sx={{ fontSize: 10, fontWeight: 600, color: logLevelColor(e.level), fontFamily: 'monospace', flexShrink: 0, minWidth: 34 }}>
                  {logLevelShort(e.level)}
                </Typography>
                {e.iface ? (
                  <Typography component="span" sx={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', fontWeight: 600, fontFamily: 'monospace', flexShrink: 0 }}>
                    [{e.iface}]
                  </Typography>
                ) : null}
                <Typography component="span" sx={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', fontFamily: 'monospace', flexShrink: 0 }}>
                  {e.category}
                </Typography>
                <Typography component="span" sx={{ fontSize: 10, color: 'rgba(255,255,255,0.85)', fontFamily: 'monospace', wordBreak: 'break-word' }}>
                  {e.message}
                </Typography>
              </Box>
            ))
          )}
      </Box>
    </FloatingPanel>
  );
}

// ── Import S7 Tag Table Dialog ────────────────────────────────────────────

function ImportTagTableDialog({
  open,
  interfaces,
  initialTargetId,
  onClose,
}: {
  open: boolean;
  interfaces: ConnectInterface[];
  initialTargetId: string | null;
  onClose: () => void;
}) {
  const mqttInterfaces = useMemo(() => interfaces.filter(i => i.type === 'MQTT'), [interfaces]);
  const s7Interfaces = useMemo(() => interfaces.filter(i => i.type === 'S7'), [interfaces]);

  const [target, setTarget] = useState<string>(initialTargetId ?? '__new__');
  // Opened via an interface's own Import button → the target is that interface;
  // no Target selector, just the file picker. The global Import button (header)
  // passes null and keeps the selector (incl. "New MQTT Interface").
  const fixedTarget = useMemo(
    () => initialTargetId !== null && interfaces.some(i => i.id === initialTargetId),
    [initialTargetId, interfaces],
  );
  // Target is an existing S7 interface → push the parsed tags as its flat `signals`
  // list (direct process-image / flag read) instead of an MQTT ProcessImage topic.
  const targetIsS7 = useMemo(
    () => interfaces.some(i => i.id === target && i.type === 'S7'),
    [interfaces, target],
  );
  const [brokerUrl, setBrokerUrl] = useState('mqtt://localhost:1883');
  const [topic, setTopic] = useState('rv/plc/process-image/raw');
  const [parsed, setParsed] = useState<ParsedTagTable | null>(null);
  const [fileName, setFileName] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  // Multi-Tab (xlsx) import state — one MQTT topic per matching tab.
  const [multiTab, setMultiTab] = useState<ParsedMultiTabTable | null>(null);
  const [sheetPattern, setSheetPattern] = useState('');
  const [forceAllAsOutput, setForceAllAsOutput] = useState(false); // per-import, never persisted
  const [topicPrefix, setTopicPrefix] = useState('');
  // Raw workbook rows, read once per file; changing the pattern/prefix/output options
  // re-filters these synchronously via buildTopicsFromRows (no re-read per keystroke).
  const [xlsxSheets, setXlsxSheets] = useState<Awaited<ReturnType<typeof readWorkbookSheets>> | null>(null);
  const isMultiTab = multiTab !== null;

  // Remembered handle (Chromium FS Access) for one-click "Re-open" of the last file.
  const [lastHandleName, setLastHandleName] = useState<string | null>(null);
  const lastHandleRef = useRef<FileSystemFileHandle | null>(null);
  const [reopenNote, setReopenNote] = useState<string | null>(null);

  // Per-tab selection — which sheets to actually import (defaults to all matching).
  const [selectedSheets, setSelectedSheets] = useState<Set<string>>(new Set());
  // Reset selection to "all" whenever the matching set of tabs changes
  // (pattern edits change it; prefix / force-output edits keep it).
  const sheetSig = multiTab ? multiTab.topics.map(t => t.sheetName).join('|') : '';
  useEffect(() => {
    if (!multiTab) { setSelectedSheets(new Set()); return; }
    setSelectedSheets(new Set(multiTab.topics.map(t => t.sheetName)));
  }, [sheetSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleSheet = useCallback((sheet: string) => {
    setSelectedSheets(prev => {
      const next = new Set(prev);
      if (next.has(sheet)) next.delete(sheet); else next.add(sheet);
      return next;
    });
  }, []);
  const chosenTopics = useMemo(
    () => (multiTab ? multiTab.topics.filter(t => selectedSheets.has(t.sheetName)) : []),
    [multiTab, selectedSheets],
  );
  const chosenSignalCount = useMemo(
    () => chosenTopics.reduce((sum, t) => sum + t.signals.length, 0),
    [chosenTopics],
  );

  // Topic browse: discover topics on the broker and pick one instead of typing.
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const [topicMenuAnchor, setTopicMenuAnchor] = useState<HTMLElement | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const discoveredTopics = useMemo(
    () => [...new Set(snap.discoveredSignals.map(s => s.browsePath || s.displayName).filter(Boolean))],
    [snap.discoveredSignals],
  );
  const handleBrowseTopics = useCallback(async (anchor: HTMLElement) => {
    if (target === '__new__') return; // discovery needs a running worker on an existing interface
    setBrowsing(true);
    try { await startDiscovery(target); } finally { setBrowsing(false); }
    setTopicMenuAnchor(anchor);
  }, [target]);

  // Sync state when the dialog opens with a (possibly different) target.
  useEffect(() => {
    if (!open) return;
    const tgt = initialTargetId ?? '__new__';
    setTarget(tgt);
    setParsed(null);
    setMultiTab(null);
    setXlsxSheets(null);
    setFileName('');
    setParseError(null);
    setPushError(null);
    setReopenNote(null);
    setForceAllAsOutput(false); // F6: per-import, always starts unchecked.
    // Pre-fill pattern / prefix from the last import so users don't retype them.
    const settings = loadInterfaceSettings();
    setSheetPattern(settings.lastSheetPattern ?? '');
    setTopicPrefix(settings.lastTopicPrefix ?? '');
    setLastHandleName(null);
    lastHandleRef.current = null;
    const existing = interfaces.find(i => i.id === initialTargetId);
    if (existing) {
      setBrokerUrl((existing.brokerUrl as string) ?? 'mqtt://localhost:1883');
    }
    // Offer "Re-open" of the last picked file (Chromium FS Access only).
    if (supportsFsAccess()) {
      let cancelled = false;
      void getLastFileHandle('lastSignalTable').then((handle) => {
        if (cancelled || !handle) return;
        lastHandleRef.current = handle;
        setLastHandleName(handle.name || settings.lastSignalTableName || null);
      });
      return () => { cancelled = true; };
    }
    return undefined;
  }, [open, initialTargetId, interfaces]);

  /**
   * Parse a chosen File (xlsx → multi-tab, csv → single-sheet) and persist the
   * last-used file name / pattern / prefix so the next import pre-selects them.
   * Shared by the file picker and the "Re-open" path.
   */
  const processFile = useCallback(async (file: File) => {
    setFileName(file.name);
    // Multi-Tab (one MQTT topic per tab) applies only to xlsx pushed to an MQTT
    // target. An S7 target always takes the flat single-sheet path (csv / sdf / xlsx).
    const isXlsx = /\.xlsx?$/i.test(file.name);
    try {
      if (isXlsx && !targetIsS7) {
        // Multi-Tab: read the workbook once, then filter synchronously.
        const sheets = await readWorkbookSheets(file);
        setXlsxSheets(sheets);
        setMultiTab(buildTopicsFromRows(sheets, { sheetPattern, forceAllAsOutput, topicPrefix }));
        setParsed(null);
        setParseError(null);
      } else {
        // Single-Sheet (csv / sdf / S7-target xlsx): flat tag list.
        setXlsxSheets(null);
        const result = await parseTagTable(file);
        setParsed(result);
        setMultiTab(null);
        setParseError(null);
      }
      // Privacy: only metadata is persisted — never file contents.
      const settings = loadInterfaceSettings();
      saveInterfaceSettings({
        ...settings,
        lastSignalTableName: file.name,
        lastSheetPattern: sheetPattern,
        lastTopicPrefix: topicPrefix,
      });
    } catch (err) {
      setParsed(null);
      setMultiTab(null);
      setParseError(err instanceof Error ? err.message : 'Import failed.');
    }
  }, [sheetPattern, forceAllAsOutput, topicPrefix, targetIsS7]);

  const handlePickFile = useCallback(async () => {
    setParseError(null);
    setReopenNote(null);
    // Chromium: native picker returns a re-usable FileSystemFileHandle.
    if (supportsFsAccess()) {
      try {
        const [handle] = await window.showOpenFilePicker!({
          types: [{
            description: 'Signal table',
            accept: {
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
              'text/csv': ['.csv'],
              'text/plain': ['.sdf'],
            },
          }],
        });
        if (!handle) return;
        const file = await handle.getFile();
        await saveLastFileHandle('lastSignalTable', handle);
        lastHandleRef.current = handle;
        setLastHandleName(handle.name);
        await processFile(file);
      } catch (err) {
        // User cancelled the native dialog — not an error.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setParseError(err instanceof Error ? err.message : 'Import failed.');
      }
      return;
    }
    // Fallback: classic <input>; only the file name can be remembered.
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.csv,.sdf';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      await processFile(file);
    };
    input.click();
  }, [processFile]);

  /** Re-open the previously imported file via its stored handle (Chromium). */
  const handleReopenLast = useCallback(async () => {
    setParseError(null);
    setReopenNote(null);
    const handle = lastHandleRef.current;
    if (!handle) return;
    const ok = await ensureReadPermission(handle);
    if (!ok) {
      setReopenNote('Access to the last file was denied — please choose it again.');
      return;
    }
    try {
      const file = await handle.getFile();
      await processFile(file);
    } catch {
      // File moved / deleted / revoked — drop the stale handle and fall back.
      lastHandleRef.current = null;
      setLastHandleName(null);
      void clearLastFileHandle('lastSignalTable');
      setReopenNote('The last file is no longer available — please choose it again.');
    }
  }, [processFile]);

  // Re-filter live when the pattern / output / prefix options change — pure and
  // synchronous over the already-read rows, so typing never re-reads the file.
  useEffect(() => {
    if (!xlsxSheets) return;
    setMultiTab(buildTopicsFromRows(xlsxSheets, { sheetPattern, forceAllAsOutput, topicPrefix }));
    setParseError(null);
  }, [xlsxSheets, sheetPattern, forceAllAsOutput, topicPrefix]);

  const handlePush = useCallback(async () => {
    setPushError(null);
    setPushing(true);
    try {
      if (targetIsS7) {
        // S7 target: push the flat tag list as the interface's `signals` (direct
        // process-image / flag read). No broker, no topic.
        if (!parsed || parsed.tags.length === 0) { setPushing(false); return; }
        await importS7TagTable(target, parsed.tags);
        await fetchInterfaces();
      } else if (isMultiTab) {
        // Multi-Tab → one InterfaceConfig with the selected topics (F9/F10).
        if (!multiTab || chosenTopics.length === 0) { setPushing(false); return; }
        let interfaceId = target;
        if (target === '__new__') {
          // Create the interface first so a stable id exists for the replacing PUT.
          // addInterface returns the server-created interface (with its real id) and
          // appends it to the store, so importMultiTabTagTable finds it directly.
          const created = await addInterface({ type: 'MQTT', enabled: true, brokerUrl } as Omit<ConnectInterface, 'id' | 'signals'>);
          interfaceId = created.id;
        } else {
          // Idempotency precondition: ensure the interface list is loaded.
          await fetchInterfaces();
        }
        await importMultiTabTagTable(chosenTopics, { interfaceId, brokerUrl });
        await fetchInterfaces();
      } else {
        // Single-Sheet path — unchanged.
        if (!parsed || parsed.tags.length === 0) { setPushing(false); return; }
        await importTagTable({
          tags: parsed.tags,
          brokerUrl,
          topic,
          targetInterfaceId: target === '__new__' ? null : target,
        });
      }
      onClose();
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Push to CONNECT failed.');
    }
    setPushing(false);
  }, [targetIsS7, isMultiTab, multiTab, chosenTopics, parsed, brokerUrl, topic, target, onClose]);

  const canPush = !pushing && (
    targetIsS7
      ? !!parsed && parsed.tags.length > 0
      : isMultiTab
        ? chosenTopics.length > 0
        : !!parsed && parsed.tags.length > 0 && topic.trim().length > 0
  );

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14 }}>
        <Upload sx={{ color: 'primary.main' }} />
        {fixedTarget
          ? `Import Tag Table → ${target} (${targetIsS7 ? 'S7' : 'MQTT'})`
          : (targetIsS7 ? 'Import S7 Tag Table → S7 Interface' : 'Import S7 Tag Table → Topic')}
      </DialogTitle>
      <DialogContent>
        {/* Target selector only for the global Import button — a per-interface
            import always targets that interface. */}
        {!fixedTarget && (
          <FormControl fullWidth size="small" sx={{ mt: 1, mb: 1.5 }}>
            <InputLabel id="import-target-label">Target</InputLabel>
            <Select
              labelId="import-target-label"
              value={target}
              label="Target"
              onChange={(e) => setTarget(e.target.value)}
            >
              <MenuItem value="__new__">New MQTT Interface</MenuItem>
              {mqttInterfaces.map(i => (
                <MenuItem key={i.id} value={i.id}>{i.id} (MQTT)</MenuItem>
              ))}
              {s7Interfaces.map(i => (
                <MenuItem key={i.id} value={i.id}>{i.id} (S7)</MenuItem>
              ))}
            </Select>
          </FormControl>
        )}

        {targetIsS7 && (
          <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 1.5 }}>
            Tags are imported directly onto the S7 interface. Their process-image / flag
            addresses (%Q, %M, %I) are read from the PLC; %I signals are written back.
          </Typography>
        )}

        {/* Broker URL — MQTT targets only. */}
        {!targetIsS7 && (
          <TextField
            fullWidth
            size="small"
            label="Broker URL"
            value={brokerUrl}
            onChange={(e) => setBrokerUrl(e.target.value)}
            placeholder="mqtt://localhost:1883"
            sx={{ mb: 1 }}
          />
        )}
        {/* Single-Sheet (csv): a single explicit topic with broker discovery — MQTT only. */}
        {!targetIsS7 && !isMultiTab && (
          <>
            <TextField
              fullWidth
              size="small"
              label="Topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="rv/plc/process-image/raw"
              sx={{ mb: 1.5 }}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <Tooltip title={target === '__new__'
                      ? 'Select an existing MQTT interface to browse topics'
                      : 'Browse topics on the broker (MQTT discovery)'}>
                      <span>
                        <IconButton
                          size="small"
                          edge="end"
                          disabled={target === '__new__' || browsing}
                          onClick={(e) => handleBrowseTopics(e.currentTarget)}
                        >
                          {browsing ? <CircularProgress size={16} /> : <Search sx={{ fontSize: 16 }} />}
                        </IconButton>
                      </span>
                    </Tooltip>
                  </InputAdornment>
                ),
              }}
            />
            <Menu
              anchorEl={topicMenuAnchor}
              open={!!topicMenuAnchor}
              onClose={() => setTopicMenuAnchor(null)}
              slotProps={{ paper: { sx: { maxHeight: 320 } } }}
            >
              {discoveredTopics.length === 0 && (
                <MenuItem disabled sx={{ fontSize: 12 }}>No topics discovered</MenuItem>
              )}
              {discoveredTopics.map(t => (
                <MenuItem
                  key={t}
                  selected={t === topic}
                  onClick={() => { setTopic(t); setTopicMenuAnchor(null); }}
                  sx={{ fontSize: 12 }}
                >
                  {t}
                </MenuItem>
              ))}
            </Menu>
          </>
        )}

        {/* Multi-Tab (xlsx): pattern filter, force-output, optional prefix. */}
        {isMultiTab && (
          <>
            <TextField
              fullWidth
              size="small"
              label="Tab filter (pattern)"
              value={sheetPattern}
              onChange={(e) => setSheetPattern(e.target.value)}
              placeholder="Data_Q*  (empty = all tabs)"
              sx={{ mb: 1 }}
            />
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={forceAllAsOutput}
                  onChange={(e) => setForceAllAsOutput(e.target.checked)}
                />
              }
              label={<Typography sx={{ fontSize: 12 }}>Treat all signals as PLC Output (incl. %I)</Typography>}
              sx={{ mb: 0.5, ml: 0, display: 'flex', alignItems: 'center' }}
            />
            <TextField
              fullWidth
              size="small"
              label="Topic prefix (optional)"
              value={topicPrefix}
              onChange={(e) => setTopicPrefix(e.target.value)}
              placeholder="rv/plc/"
              sx={{ mb: 1.5 }}
            />
          </>
        )}

        {/* Re-open the previously imported file (Chromium FS Access only). */}
        {lastHandleName && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography sx={{ fontSize: 11, color: 'text.secondary', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Last: {lastHandleName}
            </Typography>
            <Button
              variant="outlined"
              size="small"
              startIcon={<Article sx={{ fontSize: 14 }} />}
              onClick={handleReopenLast}
              sx={{ textTransform: 'none', flexShrink: 0 }}
            >
              Re-open
            </Button>
          </Box>
        )}

        <Button
          variant="outlined"
          size="small"
          startIcon={<Upload sx={{ fontSize: 14 }} />}
          onClick={handlePickFile}
          sx={{ textTransform: 'none', mb: 1 }}
        >
          Choose file (.xlsx / .csv / .sdf)
        </Button>
        {fileName && (
          <Typography sx={{ fontSize: 10, color: 'text.secondary', mb: 1 }}>
            {fileName}
          </Typography>
        )}
        {reopenNote && (
          <Typography sx={{ fontSize: 10, color: ISA_AMBER, mb: 1 }}>
            {reopenNote}
          </Typography>
        )}

        {parseError && (
          <Typography sx={{ fontSize: 11, color: ISA_RED, mb: 1 }}>
            {parseError}
          </Typography>
        )}

        {/* Preview */}
        {parsed && (
          <Box sx={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 1, p: 1 }}>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
              <Typography sx={{ fontSize: 11, color: 'text.primary' }}>
                {parsed.tags.length} Tags
              </Typography>
              <Typography sx={{ fontSize: 11, color: parsed.warnings.length > 0 ? ISA_RED : 'text.secondary' }}>
                · {parsed.warnings.length} Errors
              </Typography>
              <Typography sx={{ fontSize: 11, color: parsed.overlaps.length > 0 ? ISA_AMBER : 'text.secondary' }}>
                · {parsed.overlaps.length} Overlaps
              </Typography>
            </Box>

            {parsed.warnings.length > 0 && (
              <Box className={RV_SCROLL_CLASS} sx={{ maxHeight: 80, overflow: 'auto', mb: 0.5 }}>
                {parsed.warnings.map((w, idx) => (
                  <Typography key={idx} sx={{ fontSize: 9, color: ISA_RED, fontFamily: 'monospace' }}>
                    {w}
                  </Typography>
                ))}
              </Box>
            )}

            {parsed.overlaps.length > 0 && (
              <Box className={RV_SCROLL_CLASS} sx={{ maxHeight: 80, overflow: 'auto', mb: 0.5 }}>
                {parsed.overlaps.map((o, idx) => (
                  <Typography key={idx} sx={{ fontSize: 9, color: ISA_AMBER, fontFamily: 'monospace' }}>
                    {o}
                  </Typography>
                ))}
              </Box>
            )}

            <Box className={RV_SCROLL_CLASS} sx={{ maxHeight: 160, overflow: 'auto' }}>
              {parsed.tags.slice(0, 200).map((t, idx) => (
                <Box key={t.name + idx} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.1 }}>
                  <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.85)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.name}
                  </Typography>
                  <Chip label={t.dataType} size="small" sx={{ fontSize: 9, height: 16, '& .MuiChip-label': { px: 0.5 } }} />
                  <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace', minWidth: 56, textAlign: 'right' }}>
                    {t.address}
                  </Typography>
                </Box>
              ))}
              {parsed.tags.length > 200 && (
                <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', textAlign: 'center', py: 0.5 }}>
                  … {parsed.tags.length - 200} more
                </Typography>
              )}
            </Box>
          </Box>
        )}

        {/* Multi-Tab Preview: one topic per matching tab, ignored tabs, warnings. */}
        {multiTab && (
          <Box sx={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 1, p: 1 }}>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 0.5 }}>
              <Typography sx={{ fontSize: 11, color: 'text.primary' }}>
                {chosenTopics.length}/{multiTab.topics.length} Topics
              </Typography>
              <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                · {chosenSignalCount} Signals
              </Typography>
              <Typography sx={{ fontSize: 11, color: multiTab.warnings.length > 0 ? ISA_AMBER : 'text.secondary' }}>
                · {multiTab.warnings.length} Warnings
              </Typography>
              <Box sx={{ flex: 1 }} />
              {multiTab.topics.length > 0 && (
                <>
                  <Button
                    size="small"
                    startIcon={<SelectAll sx={{ fontSize: 12 }} />}
                    onClick={() => setSelectedSheets(new Set(multiTab.topics.map(t => t.sheetName)))}
                    sx={{ fontSize: 9, textTransform: 'none', minWidth: 0 }}
                  >
                    All
                  </Button>
                  <Button
                    size="small"
                    startIcon={<Deselect sx={{ fontSize: 12 }} />}
                    onClick={() => setSelectedSheets(new Set())}
                    sx={{ fontSize: 9, textTransform: 'none', minWidth: 0 }}
                  >
                    None
                  </Button>
                </>
              )}
            </Box>

            <Box className={RV_SCROLL_CLASS} sx={{ maxHeight: 160, overflow: 'auto', mb: 0.5 }}>
              {multiTab.topics.map((t) => (
                <Box
                  key={t.sheetName}
                  onClick={() => toggleSheet(t.sheetName)}
                  sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.1, cursor: 'pointer', borderRadius: 0.5, '&:hover': { bgcolor: 'rgba(79,195,247,0.06)' } }}
                >
                  <Checkbox
                    size="small"
                    checked={selectedSheets.has(t.sheetName)}
                    onChange={() => toggleSheet(t.sheetName)}
                    onClick={(e) => e.stopPropagation()}
                    sx={{ p: 0.25, '& .MuiSvgIcon-root': { fontSize: 14 } }}
                  />
                  <Typography sx={{ fontSize: 10, color: selectedSheets.has(t.sheetName) ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.4)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.sheetName} → "{t.topic}"
                  </Typography>
                  <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', fontFamily: 'monospace', minWidth: 70, textAlign: 'right' }}>
                    {t.signals.length} signals
                  </Typography>
                </Box>
              ))}
              {multiTab.topics.length === 0 && (
                <Typography sx={{ fontSize: 10, color: ISA_AMBER, py: 0.5 }}>
                  No tabs match the pattern.
                </Typography>
              )}
            </Box>

            {multiTab.ignoredSheets.length > 0 && (
              <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace', mb: 0.5 }}>
                ignored: {multiTab.ignoredSheets.join(', ')}
              </Typography>
            )}

            {(multiTab.warnings.length > 0 || multiTab.topics.some(t => t.warnings.length > 0)) && (
              <Box className={RV_SCROLL_CLASS} sx={{ maxHeight: 80, overflow: 'auto' }}>
                {multiTab.warnings.map((w, idx) => (
                  <Typography key={`g${idx}`} sx={{ fontSize: 9, color: ISA_AMBER, fontFamily: 'monospace' }}>
                    {w}
                  </Typography>
                ))}
                {multiTab.topics.flatMap(t => t.warnings.map((w, idx) => (
                  <Typography key={`${t.sheetName}-${idx}`} sx={{ fontSize: 9, color: ISA_AMBER, fontFamily: 'monospace' }}>
                    [{t.sheetName}] {w}
                  </Typography>
                )))}
              </Box>
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
        <Button
          variant="contained"
          onClick={handlePush}
          disabled={!canPush}
          sx={{ textTransform: 'none' }}
        >
          {pushing ? 'Pushing...' : 'Push to CONNECT'}
        </Button>
      </DialogActions>

      {/* F16: surface push failures (CONNECT offline / HTTP 4xx-5xx) — never silent. */}
      <Snackbar
        open={!!pushError}
        autoHideDuration={6000}
        onClose={() => setPushError(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity="error" variant="filled" onClose={() => setPushError(null)} sx={{ fontSize: 12 }}>
          {pushError}
        </Alert>
      </Snackbar>
    </Dialog>
  );
}

// ── Bridges: mirror rules & 1:1 signal mappings (plan-257) ──────────────────
//
// "Bridge" is the UI term for the direction-preserving signal transfer between
// interfaces (config fields stay `Mirrors`/`Mappings`): out stays out, in stays
// in — a protocol converter, never a direction flip.

interface BridgesApi {
  /** null while loading; [] when loaded and empty. */
  mirrors: ConnectMirrorRule[] | null;
  mappings: ConnectSignalMapping[] | null;
  /** False when the connected gateway lacks the /config/mirrors endpoints (older EXE). */
  supported: boolean;
  error: string | null;
  setError: (msg: string | null) => void;
  saveMirrors: (next: ConnectMirrorRule[]) => Promise<void>;
  saveMappings: (next: ConnectSignalMapping[]) => Promise<void>;
  /** Refetch from the gateway (e.g. after a profile switch swapped the whole config). */
  reload: () => Promise<void>;
}

/** Load + persist bridges while connected. Save errors (gateway validation) land in `error`. */
function useBridges(isConnected: boolean): BridgesApi {
  const [mirrors, setMirrors] = useState<ConnectMirrorRule[] | null>(null);
  const [mappings, setMappings] = useState<ConnectSignalMapping[] | null>(null);
  const [supported, setSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [mi, ma] = await Promise.all([fetchMirrors(), fetchMappings()]);
      setMirrors(mi); setMappings(ma); setSupported(true);
    } catch {
      // Older gateway without the endpoints — hide the whole bridges UI.
      setSupported(false);
    }
  }, []);

  useEffect(() => {
    if (!isConnected) {
      setMirrors(null); setMappings(null); setSupported(false); setError(null);
      return;
    }
    void reload();
  }, [isConnected, reload]);

  const saveMirrors = useCallback(async (next: ConnectMirrorRule[]) => {
    try {
      await putMirrors(next);
      setMirrors(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save mirror rules.');
      throw err;
    }
  }, []);

  const saveMappings = useCallback(async (next: ConnectSignalMapping[]) => {
    try {
      await putMappings(next);
      setMappings(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save signal mappings.');
      throw err;
    }
  }, []);

  return { mirrors, mappings, supported, error, setError, saveMirrors, saveMappings, reload };
}

/** Sink interfaces (valid mirror targets): MQTT and SHM. */
function sinkInterfaces(interfaces: ConnectInterface[]): ConnectInterface[] {
  return interfaces.filter(i => i.type === 'MQTT' || i.type === 'SHM');
}

/**
 * Compact list of all configured bridges below the interface list: mirror rules
 * (interface → sink, glob pattern) and 1:1 signal mappings, each with an enable
 * toggle and delete. Inline add-form for mirror rules; signal mappings are added
 * via the signal rows' bridge action or the "Mapping" button.
 */
function BridgeSection({
  interfaces,
  bridges,
  onAddMapping,
}: {
  interfaces: ConnectInterface[];
  bridges: BridgesApi;
  onAddMapping: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [srcId, setSrcId] = useState('');
  const [dstId, setDstId] = useState('');
  const [pattern, setPattern] = useState('*');

  const mirrors = bridges.mirrors ?? [];
  const mappings = bridges.mappings ?? [];
  const count = mirrors.length + mappings.length;
  const sinks = sinkInterfaces(interfaces);

  const handleAddMirror = useCallback(async () => {
    if (!srcId || !dstId) return;
    try {
      await bridges.saveMirrors([...(bridges.mirrors ?? []), {
        enabled: true,
        sourceInterfaceId: srcId,
        targetInterfaceId: dstId,
        signalPattern: pattern.trim() || '*',
        topicPrefix: '',
      }]);
      setAddOpen(false);
      setSrcId(''); setDstId(''); setPattern('*');
    } catch { /* error surfaced via bridges.error */ }
  }, [bridges, srcId, dstId, pattern]);

  const rowSx = { display: 'flex', alignItems: 'center', gap: 0.5, px: 0.5, py: 0.25, borderRadius: 0.5, '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' } } as const;

  return (
    <Box sx={{ flexShrink: 0, pt: 1 }}>
      <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', mb: 0.5 }} />
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.5 }}>
        <Typography sx={{ fontSize: 11, color: 'text.secondary', flex: 1 }}>
          Bridges ({count})
        </Typography>
        <Tooltip title="Mirror all signals of an interface into an MQTT/SHM sink">
          <Button
            size="small"
            startIcon={<Add sx={{ fontSize: 12 }} />}
            onClick={() => setAddOpen(o => !o)}
            sx={{ fontSize: 11, textTransform: 'none', minWidth: 0 }}
          >
            Mirror
          </Button>
        </Tooltip>
        <Tooltip title="Bridge a single signal 1:1 into another interface">
          <Button
            size="small"
            startIcon={<Add sx={{ fontSize: 12 }} />}
            onClick={onAddMapping}
            sx={{ fontSize: 11, textTransform: 'none', minWidth: 0 }}
          >
            Mapping
          </Button>
        </Tooltip>
      </Box>

      {bridges.error && (
        <Typography sx={{ fontSize: 11, color: ISA_RED, mb: 0.5 }}>{bridges.error}</Typography>
      )}

      {/* Inline add-mirror form */}
      <Collapse in={addOpen}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5, flexWrap: 'wrap' }}>
          <FormControl size="small" variant="standard" sx={{ minWidth: 90 }}>
            <Select displayEmpty value={srcId} onChange={(e) => setSrcId(e.target.value)} sx={{ fontSize: 11 }}>
              <MenuItem value="" disabled sx={{ fontSize: 12 }}>Source…</MenuItem>
              {interfaces.filter(i => i.id !== dstId).map(i => (
                <MenuItem key={i.id} value={i.id} sx={{ fontSize: 12 }}>{i.id}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <SwapHoriz sx={{ fontSize: 14, color: 'rgba(255,255,255,0.4)' }} />
          <FormControl size="small" variant="standard" sx={{ minWidth: 110 }}>
            <Select displayEmpty value={dstId} onChange={(e) => setDstId(e.target.value)} sx={{ fontSize: 11 }}>
              <MenuItem value="" disabled sx={{ fontSize: 12 }}>Target (MQTT/SHM)…</MenuItem>
              {sinks.filter(i => i.id !== srcId).map(i => (
                <MenuItem key={i.id} value={i.id} sx={{ fontSize: 12 }}>{i.id}</MenuItem>
              ))}
            </Select>
          </FormControl>
          <TextField
            size="small" variant="standard" value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="*"
            sx={{ width: 64, '& .MuiInputBase-input': { fontSize: 11 } }}
          />
          <Button size="small" disabled={!srcId || !dstId} onClick={() => void handleAddMirror()} sx={{ fontSize: 10, textTransform: 'none', minWidth: 0 }}>
            Add
          </Button>
        </Box>
        {sinks.length === 0 && (
          <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', mb: 0.5 }}>
            No MQTT/SHM sink interface yet — use an interface's Mirror button to create one automatically.
          </Typography>
        )}
      </Collapse>

      {/* Empty state stays a single quiet header line — what Mirror/Mapping do
          is explained by their button tooltips, not a standing paragraph. */}

      {mirrors.map((m, idx) => (
        <Box key={`mi-${idx}`} sx={rowSx}>
          <Switch
            size="small" checked={m.enabled}
            onChange={(e) => void bridges.saveMirrors(mirrors.map((x, i) => i === idx ? { ...x, enabled: e.target.checked } : x)).catch(() => {})}
            sx={{ transform: 'scale(0.6)', transformOrigin: 'center left', mr: -0.5 }}
          />
          <Typography sx={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.8)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {m.sourceInterfaceId} → {m.targetInterfaceId}
            {m.signalPattern && m.signalPattern !== '*' ? `  (${m.signalPattern})` : ''}
          </Typography>
          <Chip label="mirror" size="small" sx={{ height: 14, fontSize: 9, bgcolor: 'rgba(79,195,247,0.15)', color: '#4fc3f7' }} />
          <IconButton
            size="small"
            aria-label={`Delete mirror ${m.sourceInterfaceId} to ${m.targetInterfaceId}`}
            onClick={() => void bridges.saveMirrors(mirrors.filter((_, i) => i !== idx)).catch(() => {})}
            sx={{ p: 0.2, color: 'rgba(255,255,255,0.5)', '&:hover': { color: ISA_RED } }}
          >
            <Delete sx={{ fontSize: 12 }} />
          </IconButton>
        </Box>
      ))}

      {mappings.map((m, idx) => (
        <Box key={`ma-${idx}`} sx={rowSx}>
          <Switch
            size="small" checked={m.enabled}
            onChange={(e) => void bridges.saveMappings(mappings.map((x, i) => i === idx ? { ...x, enabled: e.target.checked } : x)).catch(() => {})}
            sx={{ transform: 'scale(0.6)', transformOrigin: 'center left', mr: -0.5 }}
          />
          <Typography sx={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.8)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {m.sourceSignal} → {m.destSignal}
          </Typography>
          <Chip label={m.coercion === 'Coerce' ? '1:1 coerce' : '1:1'} size="small" sx={{ height: 14, fontSize: 9, bgcolor: 'rgba(102,187,106,0.15)', color: ISA_GREEN }} />
          <IconButton
            size="small"
            aria-label={`Delete mapping ${m.sourceSignal} to ${m.destSignal}`}
            onClick={() => void bridges.saveMappings(mappings.filter((_, i) => i !== idx)).catch(() => {})}
            sx={{ p: 0.2, color: 'rgba(255,255,255,0.5)', '&:hover': { color: ISA_RED } }}
          >
            <Delete sx={{ fontSize: 12 }} />
          </IconButton>
        </Box>
      ))}
    </Box>
  );
}

// ── Signal-config profiles + historian settings ──────────────────────────────
// Moved to ConnectOptionsWindow.tsx (CONNECT Settings floating window).

/**
 * Dialog to create a 1:1 signal mapping (bridge): source signal → destination signal of another
 * interface. Opened from a signal row's bridge action (source pre-filled) or the Bridges header.
 */
function AddMappingDialog({
  open,
  sourceSignal,
  interfaces,
  bridges,
  onClose,
}: {
  open: boolean;
  sourceSignal: string;
  interfaces: ConnectInterface[];
  bridges: BridgesApi;
  onClose: () => void;
}) {
  const [source, setSource] = useState(sourceSignal);
  const [dest, setDest] = useState('');
  const [coerce, setCoerce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // All known signal names for the datalist suggestions.
  const allNames = useMemo(
    () => interfaces.flatMap(i => interfaceSignals(i).map(s => s.name)).filter(Boolean).sort(),
    [interfaces]);

  const handleAdd = useCallback(async () => {
    const src = source.trim();
    const dst = dest.trim();
    if (!src || !dst || src === dst) return;
    try {
      await bridges.saveMappings([...(bridges.mappings ?? []), {
        enabled: true,
        sourceSignal: src,
        destSignal: dst,
        coercion: coerce ? 'Coerce' : 'Strict',
      }]);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add mapping.');
    }
  }, [bridges, source, dest, coerce, onClose]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14 }}>
        <SwapHoriz sx={{ color: 'primary.main' }} />
        Bridge Signal
      </DialogTitle>
      <DialogContent sx={{ pt: 1 }}>
        <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', mb: 1.5 }}>
          Writes the value of the source signal to the destination signal of another interface.
          Direction-preserving — no direction flip, a pure protocol bridge.
        </Typography>
        {error && <Typography sx={{ fontSize: 11, color: ISA_RED, mb: 1 }}>{error}</Typography>}
        <TextField
          fullWidth size="small" label="Source signal" value={source}
          onChange={(e) => setSource(e.target.value)}
          inputProps={{ list: 'rv-bridge-signal-names' }}
          sx={{ mb: 1.5, mt: 0.5 }}
        />
        <TextField
          fullWidth size="small" label="Destination signal" value={dest}
          onChange={(e) => setDest(e.target.value)}
          inputProps={{ list: 'rv-bridge-signal-names' }}
          sx={{ mb: 1 }}
        />
        <datalist id="rv-bridge-signal-names">
          {allNames.map(n => <option key={n} value={n} />)}
        </datalist>
        <FormControlLabel
          control={<Checkbox size="small" checked={coerce} onChange={(e) => setCoerce(e.target.checked)} />}
          label={<Typography sx={{ fontSize: 11 }}>Allow type coercion (bool↔int, int→float)</Typography>}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
        <Button
          variant="contained"
          disabled={!source.trim() || !dest.trim() || source.trim() === dest.trim()}
          onClick={() => void handleAdd()}
          sx={{ textTransform: 'none' }}
        >
          Add Bridge
        </Button>
      </DialogActions>
    </Dialog>
  );
}
