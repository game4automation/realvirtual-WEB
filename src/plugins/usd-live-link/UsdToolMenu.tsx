// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { writeLocalStorage } from '../../core/rv-safe-storage';

/**
 * UsdToolMenu — the menu behind the USD button of the left tool toolbar
 * (plan-637 F1/F2/F9, reworked after the impeccable critique in Phase 7).
 * Loaded lazily by `UsdToolButton` on the first click so the entry chunk
 * carries only the icon button.
 *
 * One button, one menu (on the dark panel surface — text must stay readable
 * over any scene):
 *   Export USD…        → the open document's USD export (private provider, plan-764)
 *   Import USD…        → the unified import dialog on its USD tab (private provider)
 *   ─────────────
 *   ISAAC SIM LIVE SYNC
 *   Sync to Isaac Sim  [switch]
 *   <status> · Port 8775  ⚙ (token / port / rate)
 *   Setup and troubleshooting   (needs-token, retrying, error)
 *   ─────────────
 *   ▸ Isaac Sim extension   v0.2.0   (open until the first `live` on this device,
 *     Download extension             and whenever the extension is outdated)
 *     1. Unzip  2. Start Isaac Sim with a .bat  3. Copy the access token
 *
 * Without the private providers (community build) only Export / Import are
 * disabled — the live link is open and works without them.
 */

import { useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';
import {
  Box,
  Collapse,
  Divider,
  IconButton,
  MenuItem,
  MenuList,
  Popover,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Extension, FileDownload, FileUpload, Settings } from '@mui/icons-material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import {
  getActiveDocumentView,
  subscribeActiveDocumentView,
  type ActiveDocumentFileExport,
} from '../../core/editor/active-document-view';
import { importProviderRegistry } from '../../core/import/rv-import-provider';
import {
  ACCENT,
  ERROR,
  FS,
  ICON_SIZE,
  INK_LOW,
  INK_MID,
  LINK,
  MONO,
  PANEL_SURFACE,
  SUCCESS,
  WARN,
  inspectorInputSx,
} from '../../core/hmi/shared-sx';
import { parseDecimal } from '../../core/hmi/rv-number-format';
import { InspectorRow } from '../../core/hmi/rv-inspector-row';
import { DetailsDisclosure, InspectorSubheader } from '../../core/hmi/rv-inspector-blocks';
import { NumberEditor } from '../../core/hmi/rv-field-editors';
import type { UsdLiveLinkPlugin } from './usd-live-link-plugin';
import { USD_MENU_ID } from './UsdToolButton';
import {
  LIVE_LINK_MAX_HZ,
  LIVE_LINK_MIN_HZ,
  LIVE_LINK_TOKEN_MISSING,
  hasSeenLive,
  type LiveLinkState,
} from './live-link-store';
import { livesyncExtensionDownload, type LivesyncExtensionDownload } from './livesync-extension';

/** Provider id of the USD export / import (plan-764). */
const USD_PROVIDER_ID = 'usd';
/** The import dialog's remembered tab (UnifiedImportDialog `LAST_PROVIDER_KEY`). */
const IMPORT_LAST_PROVIDER_KEY = 'rv.import.lastProvider';
/** README of the Kit extension (installation, token, troubleshooting). */
export const LIVE_SYNC_README_URL =
  'https://github.com/game4automation/realvirtual-WEB/blob/main/integrations/omniverse-kit/README.md';
/** Minimum height of a link / small target (WCAG 2.5.8). */
const TARGET_MIN_PX = 24;
/** The first element a keyboard user lands on when the menu opens. */
const FIRST_INTERACTIVE =
  '[role="menuitem"]:not([aria-disabled="true"]), input:not([disabled]), button:not([disabled]), a[href]';

/**
 * Popover placement: anchored at the BOTTOM of the button. The button sits in
 * the lower group of the activity bar, so the menu grows upward and does not
 * jump when the settings or the extension steps open (a centre anchor moved
 * the whole menu by half of every height change).
 */
export const USD_MENU_ANCHOR = {
  anchorOrigin: { vertical: 'bottom', horizontal: 'right' },
  transformOrigin: { vertical: 'bottom', horizontal: 'left' },
} as const;

/** The USD export of the open document, or null. */
function useUsdExport(): ActiveDocumentFileExport | null {
  useSyncExternalStore(subscribeActiveDocumentView, () => getActiveDocumentView());
  return getActiveDocumentView()?.actions.exports?.find((e) => e.id === USD_PROVIDER_ID) ?? null;
}

/** True when a USD import provider is registered. */
function useUsdImportAvailable(): boolean {
  return useSyncExternalStore(
    (cb) => importProviderRegistry.onChange(cb),
    () => !!importProviderRegistry.get(USD_PROVIDER_ID),
  );
}

/** True while the connection is being retried (the first attempt failed). */
export function isRetrying(state: LiveLinkState): boolean {
  return state.status === 'connecting' && (state.attempt ?? 1) >= 2;
}

/** Status line text + colour. Waiting states are amber, only a failure is red. */
export function describeLiveLink(state: LiveLinkState, enabled: boolean): { text: string; color: string } {
  switch (state.status) {
    case 'live': return { text: `Live · ${state.sentHz || state.rateHz} Hz`, color: SUCCESS };
    case 'needs-token': return { text: state.message ?? LIVE_LINK_TOKEN_MISSING, color: WARN };
    case 'connecting':
      return { text: isRetrying(state) && state.message ? state.message : 'Connecting…', color: WARN };
    case 'mounting': return { text: state.message ?? 'Transferring the scene…', color: WARN };
    case 'error': return { text: state.message ?? 'Error', color: ERROR };
    default: return { text: enabled ? 'Starting…' : 'Off', color: INK_LOW };
  }
}

/** True when the status line links to the README (setup and troubleshooting). */
export function showsTroubleshooting(state: LiveLinkState): boolean {
  return state.status === 'error' || state.status === 'needs-token' || isRetrying(state);
}

/** Hint under the status line after a sync that left textures out, or null. */
export function describeTextureNotice(state: LiveLinkState): string | null {
  const n = state.texturesSkipped ?? 0;
  if (n <= 0 || (state.status !== 'live' && state.status !== 'mounting')) return null;
  return `${n} ${n === 1 ? 'texture' : 'textures'} skipped (not exportable)`;
}

/** The three install steps under the download link. */
export const EXTENSION_INSTALL_STEPS = [
  'Unzip the download.',
  'Double-click run_isaac_sim_nvidia_only.bat — or run_isaac_sim_with_realvirtual.bat.',
  'Copy the access token from the realvirtual Live Sync panel into the connection settings (⚙).',
] as const;

/** Whether the "Isaac Sim extension" disclosure starts open. */
export function extensionSectionDefaultOpen(state: LiveLinkState): boolean {
  return !!state.extensionNotice || !hasSeenLive();
}

/** A text link with a 24px target. */
function TextLink({ href, children, testId, download, icon }: {
  href: string; children: ReactNode; testId?: string; download?: boolean; icon?: ReactNode;
}) {
  return (
    <Box
      component="a"
      href={href}
      data-testid={testId}
      {...(download ? { download: true } : { target: '_blank', rel: 'noreferrer' })}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        minHeight: TARGET_MIN_PX,
        fontSize: FS.label,
        color: LINK,
        textDecoration: 'none',
        '&:hover': { textDecoration: 'underline' },
        '&:focus-visible': { outline: `1px solid ${ACCENT}`, outlineOffset: 1 },
      }}
    >
      {icon}{children}
    </Box>
  );
}

/** The "Isaac Sim extension" disclosure: download link + install steps. */
function ExtensionSection({ download, defaultOpen }: { download: LivesyncExtensionDownload | null; defaultOpen: boolean }) {
  return (
    <DetailsDisclosure
      title="Isaac Sim extension"
      summary={download ? `v${download.version}` : undefined}
      defaultOpen={defaultOpen}
      data-testid="usd-menu-extension-disclosure"
    >
      <Box data-testid="usd-menu-extension" sx={{ px: 2, pb: 0.75 }}>
        {download ? (
          <TextLink
            href={download.url}
            download
            testId="usd-menu-extension-download"
            icon={<Extension sx={{ fontSize: ICON_SIZE.md }} />}
          >
            Download extension (v{download.version})
          </TextLink>
        ) : (
          <Typography sx={{ fontSize: FS.label, color: INK_MID }}>
            Not included in this build — <TextLink href={LIVE_SYNC_README_URL}>see the README</TextLink>
          </Typography>
        )}
        <Box component="ol" sx={{ m: 0, mt: 0.25, pl: 2.25, color: INK_MID, fontSize: FS.label }}>
          {EXTENSION_INSTALL_STEPS.map((step) => <li key={step}>{step}</li>)}
        </Box>
      </Box>
    </DetailsDisclosure>
  );
}

function useLiveLink(plugin: UsdLiveLinkPlugin | null): LiveLinkState | null {
  return useSyncExternalStore(
    plugin?.store.subscribe ?? (() => () => {}),
    plugin?.store.getSnapshot ?? (() => null),
  );
}

/** The dialog opened from the menu (rendered by the button, closed by it). */
type Dialog = { node: (close: () => void) => ReactNode } | null;

export interface UsdToolMenuProps extends UISlotProps {
  /** The USD button the menu opens at, or null while the menu is closed. */
  anchorEl: HTMLElement | null;
  onClose: () => void;
}

/** Secondary text of a file action that this build does not provide. */
function NotInBuild() {
  return <Box component="span" sx={{ ml: 'auto', fontSize: FS.micro, color: INK_LOW }}>Not in this build</Box>;
}

/** The inspector's inline text field (StringEditor): 18px input, MONO value, field tokens. */
const fieldSx = { '& .MuiOutlinedInput-root': inspectorInputSx } as const;
const fieldInputSlot = { sx: { fontSize: FS.label, fontFamily: MONO, height: 18 } } as const;

export function UsdToolMenu({ viewer, anchorEl, onClose }: UsdToolMenuProps) {
  const plugin = viewer.getPlugin<UsdLiveLinkPlugin>('usd-live-link') ?? null;
  const state = useLiveLink(plugin);
  const usdExport = useUsdExport();
  const importAvailable = useUsdImportAvailable();
  const [showSettings, setShowSettings] = useState(() => plugin?.store.state.status === 'needs-token');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState('');
  const paperRef = useRef<HTMLDivElement | null>(null);
  const tokenRef = useRef<HTMLInputElement | null>(null);
  /** Focus the token field once the settings finished opening. */
  const focusTokenOnEnter = useRef(false);

  if (!plugin || !state) return null;
  const enabled = plugin.syncEnabled;
  const settings = plugin.store.settings;
  const status = describeLiveLink(state, enabled);
  const textureNotice = describeTextureNotice(state);
  const download = livesyncExtensionDownload();
  const switchOn = state.status !== 'off';
  const portLocked = state.status === 'connecting' || state.status === 'mounting' || state.status === 'live';

  const openExport = async () => {
    if (!usdExport) return;
    onClose();
    try {
      const modes = usdExport.modes();
      const { DocumentFileExportDialog } = await import('../../core/hmi/scene/DocumentFileExportDialogs');
      const download = (bytes: ArrayBuffer | Uint8Array, mime: string, fileName: string) => {
        const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      };
      setDialog({
        node: (close) => (
          <DocumentFileExportDialog exp={usdExport} modes={modes} onClose={close} onMessage={setMessage} download={download} />
        ),
      });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const openImport = async () => {
    if (!importAvailable) return;
    onClose();
    try { writeLocalStorage(IMPORT_LAST_PROVIDER_KEY, USD_PROVIDER_ID); } catch { /* private mode */ }
    const { UnifiedImportDialog } = await import('../unified-import/UnifiedImportDialog');
    setDialog({ node: (close) => <UnifiedImportDialog viewer={viewer} open onClose={close} /> });
  };

  /** Open the settings (never closes them) and put the cursor into the token field. */
  const focusToken = () => {
    if (showSettings) { tokenRef.current?.focus(); return; }
    focusTokenOnEnter.current = true;
    setShowSettings(true);
  };

  const toggleSync = (on: boolean) => {
    plugin.setSyncEnabled(on);
    if (on && plugin.store.state.status === 'needs-token') focusToken();
  };

  const commitToken = (value: string) => plugin.commitToken(value);
  // TextField puts onKeyDown on its root: the value comes from the event target (the input).
  const onTokenKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) commitToken(e.target.value);
  };

  const commitPort = () => {
    const n = parseDecimal(portDraft);
    if (n !== null && Number.isInteger(n) && n > 0 && n < 65536) plugin.setPort(n);
    setPortDraft('');
  };

  /** Keyboard users land on the first interactive element (the token field while it is missing). */
  const focusFirst = () => {
    if (plugin.store.state.status === 'needs-token' && showSettings && tokenRef.current) {
      tokenRef.current.focus();
      return;
    }
    paperRef.current?.querySelector<HTMLElement>(FIRST_INTERACTIVE)?.focus();
  };

  const closeDialog = () => setDialog(null);

  return (
    <>
      <Popover
        anchorEl={anchorEl}
        open={!!anchorEl}
        onClose={onClose}
        anchorOrigin={USD_MENU_ANCHOR.anchorOrigin}
        transformOrigin={USD_MENU_ANCHOR.transformOrigin}
        slotProps={{
          paper: {
            id: USD_MENU_ID,
            ref: paperRef,
            role: 'dialog',
            'aria-label': 'USD',
            'data-testid': 'usd-menu-paper',
            sx: { ml: 1, width: 300, py: 0.5, backgroundColor: `${PANEL_SURFACE} !important` },
          } as never,
          transition: { onEntered: focusFirst },
        }}
      >
        <Box data-testid="usd-menu">
          <MenuList dense aria-label="USD files" sx={{ py: 0 }}>
            <MenuItem
              data-testid="usd-menu-export"
              disabled={!usdExport}
              onClick={() => { void openExport(); }}
              sx={{ fontSize: FS.body, gap: 1, minHeight: 28 }}
            >
              <FileDownload sx={{ fontSize: ICON_SIZE.md }} /> Export USD…
              {!usdExport && <NotInBuild />}
            </MenuItem>
            <MenuItem
              data-testid="usd-menu-import"
              disabled={!importAvailable}
              onClick={() => { void openImport(); }}
              sx={{ fontSize: FS.body, gap: 1, minHeight: 28 }}
            >
              <FileUpload sx={{ fontSize: ICON_SIZE.md }} /> Import USD…
              {!importAvailable && <NotInBuild />}
            </MenuItem>
          </MenuList>
          <Divider sx={{ my: 0.5 }} />
          <InspectorSubheader data-testid="usd-menu-sync-header">Isaac Sim live sync</InspectorSubheader>
          <Box sx={{ display: 'flex', alignItems: 'center', px: 2 }}>
            <Typography component="label" htmlFor="usd-menu-sync-input" sx={{ fontSize: FS.body, flex: 1 }}>
              Sync to Isaac Sim
            </Typography>
            <Switch
              size="small"
              checked={switchOn}
              onChange={(_, on) => toggleSync(on)}
              slotProps={{
                input: { id: 'usd-menu-sync-input', role: 'switch', 'aria-label': 'Sync to Isaac Sim', 'data-testid': 'usd-menu-sync' } as never,
              }}
            />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 2, pb: 0.25 }}>
            <Typography
              data-testid="usd-menu-status"
              role="status"
              aria-live="polite"
              sx={{ fontSize: FS.label, color: status.color, flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
            >
              {status.text}
              <Box component="span" sx={{ color: INK_LOW }}>
                {' · Port '}
                <Box component="span" sx={{ fontFamily: MONO }}>{state.port}</Box>
              </Box>
            </Typography>
            <Tooltip title="Connection settings" placement="right">
              <IconButton
                size="small"
                aria-label="Connection settings"
                aria-expanded={showSettings}
                aria-controls="usd-menu-settings"
                data-testid="usd-menu-settings-toggle"
                onClick={() => setShowSettings((v) => !v)}
              >
                <Settings sx={{ fontSize: ICON_SIZE.sm, color: showSettings ? ACCENT : INK_MID }} />
              </IconButton>
            </Tooltip>
          </Box>
          {textureNotice && (
            <Typography data-testid="usd-menu-texture-notice" sx={{ fontSize: FS.label, color: WARN, px: 2, pb: 0.5 }}>
              {textureNotice}
            </Typography>
          )}
          {state.extensionNotice && (
            <Typography data-testid="usd-menu-extension-notice" sx={{ fontSize: FS.label, color: WARN, px: 2, pb: 0.5 }}>
              {download ? (
                <a href={download.url} download style={{ color: 'inherit' }}>{state.extensionNotice}</a>
              ) : state.extensionNotice}
            </Typography>
          )}
          {showsTroubleshooting(state) && (
            <Box sx={{ px: 2 }}>
              <TextLink href={LIVE_SYNC_README_URL} testId="usd-menu-troubleshooting">Setup and troubleshooting</TextLink>
            </Box>
          )}
          <Collapse
            in={showSettings}
            onEntered={() => {
              if (!focusTokenOnEnter.current) return;
              focusTokenOnEnter.current = false;
              tokenRef.current?.focus();
            }}
          >
            <Box
              id="usd-menu-settings"
              data-testid="usd-menu-settings"
              sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, px: 1, pt: 0.5, pb: 1 }}
            >
              <InspectorRow label="Access token" labelColor={INK_MID} fullWidthField>
                <TextField
                  size="small"
                  type="password"
                  autoComplete="off"
                  fullWidth
                  defaultValue={settings.token}
                  inputRef={tokenRef}
                  onBlur={(e) => commitToken(e.target.value)}
                  onKeyDown={onTokenKey}
                  sx={fieldSx}
                  slotProps={{
                    input: fieldInputSlot,
                    htmlInput: {
                      'data-testid': 'usd-menu-token',
                      'aria-label': 'Access token',
                      'aria-describedby': 'usd-menu-token-help',
                    },
                  }}
                />
              </InspectorRow>
              <Typography id="usd-menu-token-help" sx={{ fontSize: FS.label, color: INK_MID, px: 1 }}>
                Shown in the realvirtual Live Sync panel of Isaac Sim.
              </Typography>
              <InspectorRow label="Port" labelColor={INK_MID}>
                <TextField
                  size="small"
                  fullWidth
                  value={portDraft || String(settings.port)}
                  disabled={portLocked}
                  onChange={(e) => setPortDraft(e.target.value)}
                  onBlur={commitPort}
                  sx={fieldSx}
                  slotProps={{
                    input: fieldInputSlot,
                    htmlInput: { inputMode: 'numeric', 'aria-label': 'Port', 'data-testid': 'usd-menu-port' },
                  }}
                />
              </InspectorRow>
              <InspectorRow label="Rate" labelColor={INK_MID} fullWidthField>
                <Box data-testid="usd-menu-rate" sx={{ minWidth: 0 }}>
                  <NumberEditor
                    value={settings.rateHz}
                    onChange={(hz) => plugin.setRateHz(hz)}
                    unit="Hz"
                    min={LIVE_LINK_MIN_HZ}
                    max={LIVE_LINK_MAX_HZ}
                    ariaLabel="Rate"
                  />
                </Box>
              </InspectorRow>
            </Box>
          </Collapse>
          <Divider sx={{ my: 0.5 }} />
          <ExtensionSection
            // Remount when the extension turns outdated: the hint opens the steps.
            key={state.extensionNotice ? 'outdated' : 'current'}
            download={download}
            defaultOpen={extensionSectionDefaultOpen(state)}
          />
        </Box>
      </Popover>
      {dialog?.node(closeDialog)}
      {message && (
        <Popover
          open
          anchorReference="none"
          onClose={() => setMessage(null)}
          slotProps={{ paper: { sx: { position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', p: 1.5, maxWidth: 420 } } }}
        >
          <Typography sx={{ fontSize: FS.body }}>{message}</Typography>
        </Popover>
      )}
    </>
  );
}
