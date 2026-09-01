// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * realvirtual Web Viewer — Entry Point
 *
 * Thin orchestrator that creates an RVViewer, handles model selection
 * (URL params, localStorage, Firebase demo mode), and initializes the HMI.
 *
 * All 3D, simulation, and data logic lives in RVViewer (core/rv-viewer.ts)
 * and the engine subsystems (core/engine/).
 * All UI lives in core/hmi/ (layout) and custom/ (content).
 */

import { RVViewer, type RendererKind } from './core/rv-viewer';
import { LoadAbortedError } from './core/engine/rv-scene-loader';
import type { RVExtrasOverlay } from './core/engine/rv-extras-overlay-store';
import { debug, logInfo } from './core/engine/rv-debug';
import { initTestRunner } from './rv-test-runner';
import { fetchAppConfig, setAppConfig, initAnalytics, lockedModeOf, trackAnalyticsEvent } from './core/rv-app-config';
import { initFragmentSecret, decryptModelData } from './core/hmi/password-gate';
import { isLoopbackOrigin } from './core/hmi/connect-store';
import { isEncryptedEnvelope } from './core/persistence/rv-crypto-utils';
import { requireAnalyticsConsent } from './core/hmi/consent-gate';
import { loadVisualSettings, hasStoredVisualSettings } from './core/hmi/visual-settings-store';
import { applyUIBlurScale } from './core/hmi/rv-ui-blur';
import { loadPublishedPresets, seedInitialVisualPreset } from './core/hmi/visual-presets';
import {
  chooseInitialQualityPreset, markAutoQualityApplied, queueAutoQualityNotice,
  FAST_PRESET_NAME,
} from './core/hmi/auto-quality';
import { isMobileDevice } from './hooks/use-mobile-layout';
import { activateContext, registerUIElement, setContext } from './core/hmi/ui-context-store';
import { isSupported as isFsApiSupported, listSubfolderFiles, readFileAsUrl } from './core/engine/rv-local-filesystem';
import {
  canonicalModelUrl, modelFetchUrl, modelFileName, setModelRevision,
} from './core/rv-model-catalog';
import {
  RVModelUpdateCoordinator, installModelUpdateCoordinator,
} from './core/rv-model-update-coordinator';
import { captureViewState, restoreViewState } from './core/rv-view-state';
import { showInstruction, hideInstruction } from './core/hmi/instruction-store';
import { hideInfoOverlay } from './core/hmi/info-overlay-store';
import { setBrandedSplashVisible } from './core/hmi/scene-transition-store';

// Private content (resolves to stubs when private folder is absent)
import { initHMI } from '@rv-private/custom/hmi-entry';
import { registerPrivatePlugins } from '@rv-private/private-plugins';
import { smoothMotionRegistry } from './core/engine/rv-smooth-motion-port';

// Hide AGPL watermark only for explicitly commercial builds (RV_COMMERCIAL=1).
// Presence of the private folder alone no longer hides it, so the AGPL
// watermark stays visible in normal dev/private builds as well.
if (__RV_COMMERCIAL__) {
  const wm = document.getElementById('rv-watermark');
  if (wm) wm.style.display = 'none';
}

// Core Plugins (always included in public AGPL build)
import { SensorMonitorPlugin } from './plugins/sensor-monitor-plugin';
import { TransportStatsPlugin } from './plugins/transport-stats-plugin';
import { CameraEventsPlugin } from './plugins/camera-events-plugin';
import { DriveOrderPlugin } from './plugins/drive-order-plugin';
import { IKPathVisualizerPlugin } from './plugins/ik-path-visualizer-plugin';
import { PathVisualizerPlugin } from './plugins/path-visualizer-plugin';
import { IKTargetEditPlugin } from './plugins/ik-target-edit-plugin';
import { DriveAxisGizmoPlugin } from './plugins/drive-axis-gizmo-plugin';
import { CameraStartPosPlugin } from './plugins/camera-startpos-plugin';
import { CameraFollowPlugin } from './plugins/camera-follow-plugin';
import { KioskPlugin } from './plugins/kiosk-plugin';
import { AdaptiveNavPlugin } from './plugins/adaptive-nav-plugin';
import { MeasurementPlugin } from './plugins/measurement-plugin';
import { ClippingPlugin } from './plugins/rv-clipping-plugin';
import { OrientationGizmoPlugin } from './plugins/rv-orientation-gizmo-plugin';
import { WebErrorPlugin } from './plugins/web-error-plugin';
import { CollisionAlertPlugin } from './plugins/collision-alert-plugin';
import { installAasResolution } from './plugins/aas-resolution';
import {
  registerModelOptionModules,
  withOptionParam,
  type ModelOptionsModule,
} from './plugins/models/model-option-plugin';
import { CustomRuntimeInstructionPlugin } from './plugins/custom-runtime-instruction-plugin';
import { WebComponentPlugin } from './plugins/web-component-plugin';
import { ConnectionSystemPlugin } from './plugins/connection-system-plugin';
import { ConnectionGizmoPlugin } from './plugins/connection-gizmo-plugin';

// Extras editor plugin (hierarchy browser + property editor)
import { RvExtrasEditorPlugin } from './core/hmi/rv-extras-editor';

// Layout Planner (public — private extensions can attach via setExtension())
import { LayoutPlannerPlugin } from './plugins/layout-planner';
import { SnapPointPlugin } from './plugins/snap-point';
import { SnapFlipIconOverlay } from './plugins/snap-point/snap-flip-icon-overlay';

// SimController: Play/Pause-Toggle + Reset (TopBar toolbar widget).
import { SimControllerPlugin } from './plugins/sim-controller';

// DES workspace shell (plan-198) — UI surface for the DES mode.
import { DESWorkspacePlugin } from './plugins/des/des-workspace-plugin';

// Scene window: multi-scene browser + layout registry
import { initSceneStore } from './core/hmi/scene/scene-store-singleton';
import { migrateLegacyAutosave } from './core/hmi/scene/layout-registry';
import { resolvePublishedSceneParam } from './core/hmi/scene/rv-published-scenes';
import { readActiveId, listMetas } from './core/hmi/scene/rv-scene-storage';
// Active-id writes go through the mutation bus, never through the storage
// function directly — this call site sits OUTSIDE SceneStore, so a
// store-internal notifier could not reach it (plan-370 RR3).
import { setActiveSceneId } from './core/hmi/scene/rv-scene-mutations';
import { getProjectStore } from './core/project/project-store';
import { scriptRefForModelUrl } from './core/project/rv-project-refs';
import { requestProjectCodeConsent } from './core/project/rv-project-code-consent';

import {
  clearAllOverrides as clearAllPluginOverrides,
  loadOverrides as loadPluginOverrides,
  overrideScopeKey,
  saveOverrides as savePluginOverrides,
} from './core/plugin-overrides/rv-plugin-override-store';
// plan-716 §2.4 — an old `?scene=scn_…` link resolves through the alias map onto
// the document it became, and the address bar is normalised to `?doc=`.
import { resolveSceneRoute, sceneUrlToDocumentUrl } from './core/project/rv-doc-alias';
import { documentsOf, findStartDocument } from './core/project/rv-project-documents';
import { diagnoseKioskBoot, projectStartDocument, resolveResumeTarget } from './core/project/rv-project-open';
import { forgetRememberedSession, readRememberedSession } from './core/project/rv-project-resume-store';
import { reportMissingDocument } from './core/hmi/scene/rv-scene-live-sync';
import { openProjectsDashboard } from './core/hmi/projects/projects-dashboard-store';
import { DEMO_PROJECT_FOLDER } from './core/project/backends/bundled-backend';
import { getLibraryStore } from './core/library/library-store-singleton';
import { installProjectLibraryProvider } from './core/library/project-library-provider';
import { installGlobalLibraryProvider } from './core/library/global-library-provider';
import { readProjectLibraries } from './core/library/project-libraries';
import { getCadGlbCacheSize, clearCadGlbCache } from './core/import/rv-cad-glb-cache';

// CONNECT gateway plugin (NavButton + LeftPanel for interface management)
import { ConnectPlugin } from './plugins/connect-plugin';
import { getStoredConnectPanelWidth } from './core/hmi/layout-constants';
import {
  attachConnectEmbedModeManager,
  completeConnectEmbedDemoLoad,
  failConnectEmbedDemoLoad,
  getConnectEmbedSnapshot,
  initializeConnectEmbedStore,
} from './plugins/connect-embed/connect-embed-store';
import { HistorianTrendPlugin } from './plugins/historian-trend-plugin';
import { SignalBindPlugin } from './plugins/signal-bind/SignalBindPlugin';

// Shared asset links — `?glb=<url>` / `?glb=s:<id>` (plan-386).
import { SharePlugin, setSharedBookmarkHost } from './core/share/share-plugin';
import { SaveDialogsPlugin } from './core/hmi/scene/SaveDialogs';
import { bootSharedGlb } from './core/share/rv-share-boot';
import { installShareIdResolver } from './core/share/rv-share-upload';
import { consumeMagicLinkFromUrl } from './core/share/rv-share-session';

// Industrial interface plugins (WebSocket Realtime, ctrlX, etc.)
import { InterfaceManager } from './interfaces/interface-manager';
import { WebSocketRealtimeInterface } from './interfaces/websocket-realtime-interface';
import { CtrlXInterface } from './interfaces/ctrlx-interface';
import { MqttInterface } from './interfaces/mqtt-interface';
import { TwinCatHmiInterface } from './interfaces/twincat-hmi-interface';

// Per-model plugin manager (loads/unloads plugins on model switch)
import { ModelPluginManager } from './core/rv-model-plugin-manager';

// Microsoft Teams JS SDK — dynamically imported only when ?teams=1

// --- localStorage keys ---
const LS_KEY_MODEL = 'rv-webviewer-last-model';
const LS_KEY_RENDERER = 'rv-webviewer-renderer';

// --- Renderer selection via URL parameter (fallback to localStorage) ---
// Three-way (plan-271): 'webgl' (default) | 'webgpu' | 'webgpu-gl' (internal
// TSL test path — WebGPURenderer with forceWebGL). Unknown/legacy values fall
// back to 'webgl' (defensive rollback safety, review finding 13).
// Mobile/touch devices always use WebGL — WebGPU is desktop-only unless explicitly overridden.
const params = new URLSearchParams(window.location.search);
const isTouchDevice = isMobileDevice();
const rendererParam = params.get('renderer') ?? localStorage.getItem(LS_KEY_RENDERER);
const rendererKind: RendererKind =
  !isTouchDevice && (rendererParam === 'webgpu' || rendererParam === 'webgpu-gl')
    ? rendererParam
    : 'webgl';

// --- Loading overlay ---
const loadingOverlay = document.getElementById('loading-overlay')!;
const loadingStatus = document.getElementById('loading-status')!;
const loadingLabel = document.getElementById('loading-label')!;
const loadingModelName = document.getElementById('loading-model-name')!;
const loadingProgressBar = document.getElementById('loading-progress-bar')!;
const loadingProgressPct = document.getElementById('loading-progress-pct')!;
const loadingProgressWrap = loadingProgressBar.parentElement?.parentElement ?? null;
const loadingError = document.getElementById('loading-error')!;
const loadingErrorDetail = document.getElementById('loading-error-detail')!;
const loadingRetryBtn = document.getElementById('loading-retry-btn') as HTMLButtonElement;
const loadingReloadBtn = document.getElementById('loading-reload-btn') as HTMLButtonElement;

function showLoadingOverlay(modelName: string) {
  loadingLabel.textContent = 'Loading ';
  loadingModelName.textContent = modelName;
  loadingProgressBar.classList.add('indeterminate');
  loadingProgressBar.style.width = '';
  loadingProgressPct.textContent = '';
  hideLoadingError();
  loadingOverlay.classList.remove('fade-out', 'hidden');
  // ONE loading indicator at a time: this splash owns the load from here. An
  // info overlay shown for the pre-load phase (SceneStore's "Loading …")
  // hands over now — `showInfoOverlay` already refuses NEW shows while the
  // splash is up; this is the other direction. Same statement to the scene
  // transition store, so "Opening editor…" waits until the splash is gone.
  hideInfoOverlay();
  setBrandedSplashVisible(true);
}

// Show the error card inside the loading overlay (download/parse failed after all
// retries, or the WebGL context was lost). On mobile the console is invisible, so
// surfacing the failure here — with a Retry — is the difference between a usable
// error and a silent "empty scene". `detail` is a short, user-readable reason.
function showLoadingError(detail: string) {
  if (loadingProgressWrap) loadingProgressWrap.style.display = 'none';
  loadingStatus.style.display = 'none';
  loadingErrorDetail.textContent = detail;
  loadingError.classList.remove('hidden');
  loadingOverlay.classList.remove('fade-out', 'hidden');
  setBrandedSplashVisible(true);
}

function hideLoadingError() {
  loadingError.classList.add('hidden');
  loadingStatus.style.display = '';
  if (loadingProgressWrap) loadingProgressWrap.style.display = '';
}

// Indeterminate "Retrying (n/total)…" status between failed download attempts.
function setLoadingRetrying(attempt: number, total: number) {
  loadingLabel.textContent = `Connection problem — retrying (${attempt}/${total})…`;
  loadingModelName.textContent = '';
  loadingProgressBar.classList.add('indeterminate');
  loadingProgressBar.style.width = '';
  loadingProgressPct.textContent = '';
}

function setLoadingProgress(loaded: number, total: number) {
  // Download finished — what's left is GLB parse + scene construction, which
  // report no byte progress. Hand off to the indeterminate "preparing" state so
  // the bar doesn't sit deceptively full while seconds of work remain.
  if (total > 0 && loaded >= total) {
    setLoadingPreparing();
    return;
  }
  const pct = Math.round((loaded / total) * 100);
  loadingProgressBar.classList.remove('indeterminate');
  loadingProgressBar.style.width = `${pct}%`;
  const loadedMB = (loaded / (1024 * 1024)).toFixed(1);
  const totalMB = (total / (1024 * 1024)).toFixed(1);
  loadingProgressPct.textContent = `${loadedMB} / ${totalMB} MB`;
}

// Post-download phase: bytes are in, now parsing the GLB + building the scene.
// Animated (indeterminate) bar + label so the user knows work is still ongoing.
function setLoadingPreparing() {
  loadingProgressBar.classList.add('indeterminate');
  loadingProgressBar.style.width = '';
  loadingProgressPct.textContent = 'Preparing scene…';
}

function hideLoadingOverlay() {
  loadingOverlay.classList.add('fade-out');
  // Released at the START of the fade, not after it: a transition held through
  // the load ("Opening editor…") may surface under the fading splash rather
  // than pop in 600 ms after the screen already looked done.
  setBrandedSplashVisible(false);
  setTimeout(() => {
    loadingOverlay.classList.add('hidden');
    loadingOverlay.classList.remove('fade-out');
  }, 600);
}

/**
 * Escape hatch for the "a huge scene locks me out on every reload" trap. When
 * the scene auto-restored on boot carries large imported CAD data, ask before
 * loading it instead of silently churning for minutes. Pure DOM — React is not
 * mounted this early in boot. Resolves with the user's choice.
 */
function askRestoreChoice(sceneName: string, sizeMB: number): Promise<'open' | 'empty' | 'clear'> {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.setAttribute('role', 'dialog');
    ov.style.cssText =
      'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,0.6);font-family:system-ui,-apple-system,sans-serif;';
    const card = document.createElement('div');
    card.style.cssText =
      'background:#1e1e1e;color:#eee;border-radius:8px;padding:22px 26px;max-width:440px;' +
      'box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:8px;';
    title.textContent = 'Restore last scene?';
    const body = document.createElement('div');
    body.style.cssText = 'font-size:13px;line-height:1.5;color:#bbb;margin-bottom:20px;';
    const nameEl = document.createElement('b');
    nameEl.style.color = '#ddd';
    nameEl.textContent = sceneName;
    body.append('“', nameEl,
      `” holds large imported CAD data (~${sizeMB} MB) and can be slow to open. Start empty ` +
      `instead (the saved scene stays in your list), or clear the CAD cache to free the space.`);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';
    const mkBtn = (labelText: string, choice: 'open' | 'empty' | 'clear', primary: boolean) => {
      const btn = document.createElement('button');
      btn.textContent = labelText;
      btn.style.cssText =
        'font-size:12px;padding:7px 14px;border-radius:5px;cursor:pointer;border:1px solid ' +
        (primary ? '#2b7de9;background:#2b7de9;color:#fff;' : '#444;background:transparent;color:#ddd;');
      btn.onclick = () => { ov.remove(); resolve(choice); };
      return btn;
    };
    row.append(
      mkBtn('Clear CAD cache', 'clear', false),
      mkBtn('Start empty', 'empty', false),
      mkBtn('Open anyway', 'open', true),
    );
    card.append(title, body, row);
    ov.append(card);
    document.body.append(ov);
  });
}

/**
 * Heavy-CAD escape hatch shared by BOTH restore paths — `?scene=<id>` in the URL
 * and the localStorage auto-restore. Returns true if the caller should open the
 * scene. On "empty"/"clear" it drops the active-scene pointer and strips `?scene=`
 * from the URL so a reload/bookmark does not immediately reload the heavy scene,
 * and returns false so the caller falls through to the light default boot.
 */
async function guardHeavyRestore(sceneId: string, displayName?: string): Promise<boolean> {
  const HEAVY_CAD_BYTES = 40 * 1024 * 1024;
  let bytes = 0;
  try { bytes = await getCadGlbCacheSize(); } catch { return true; }
  if (bytes <= HEAVY_CAD_BYTES) return true;

  // `displayName` is for a caller whose document is NOT a saved scene — the
  // project-resume path restores manifest documents too, and asking about "the
  // last scene" when the user left off in a model names the wrong thing.
  const name = displayName ?? listMetas().find(m => m.id === sceneId)?.name ?? 'The last scene';
  hideLoadingOverlay(); // don't leave the loading bar behind the dialog
  const choice = await askRestoreChoice(name, Math.round(bytes / 1048576));
  if (choice === 'open') return true;

  if (choice === 'clear') await clearCadGlbCache();
  setActiveSceneId(null);
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.has('scene')) {
      u.searchParams.delete('scene');
      window.history.replaceState(null, '', u.toString());
    }
  } catch { /* ignore URL rewrite failures */ }
  return false;
}

/**
 * Download a GLB into a single ArrayBuffer with progress, a timeout and retries.
 *
 * Replaces the old fetch → chunks[] → Blob → object-URL path, which buffered the
 * file TWICE (chunk array + Blob). For large CAD GLBs on memory-constrained
 * mobile browsers that doubled peak memory and was a frequent out-of-memory →
 * blank-scene cause. Here the body streams straight into one pre-sized buffer.
 *
 * Robustness (all mobile-only failure modes in practice):
 * - `timeoutMs` aborts a stalled fetch — mobile networks silently drop requests.
 * - Up to `attempts` tries with linear back-off recover transient drops.
 * - A short stream (fewer bytes than content-length, i.e. a dropped connection)
 *   is treated as a failed attempt, not a corrupt model handed to the parser.
 * - A longer stream than content-length (gzip/br transfer-encoding) falls back
 *   to a growable collector instead of truncating.
 *
 * Throws after the final attempt; the caller surfaces a visible error overlay.
 */
async function downloadGlb(
  url: string,
  opts: { attempts: number; timeoutMs: number; onRetry: (attempt: number, total: number) => void },
): Promise<ArrayBuffer> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const len = parseInt(resp.headers.get('content-length') || '0', 10);

      // Streamed path: single pre-sized buffer + byte-accurate progress.
      if (resp.body && len > 0) {
        const buf = new Uint8Array(len);
        const reader = resp.body.getReader();
        let offset = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (offset + value.byteLength > len) {
            // Actual bytes exceed content-length (compressed transfer-encoding) —
            // switch to a growable collector seeded with what we already have.
            const parts: Uint8Array[] = [buf.slice(0, offset), value];
            let extraLen = offset + value.byteLength;
            for (;;) {
              const r = await reader.read();
              if (r.done) break;
              parts.push(r.value);
              extraLen += r.value.byteLength;
            }
            clearTimeout(timer);
            const out = new Uint8Array(extraLen);
            let o = 0;
            for (const c of parts) { out.set(c, o); o += c.byteLength; }
            return out.buffer;
          }
          buf.set(value, offset);
          offset += value.byteLength;
          setLoadingProgress(offset, len);
        }
        clearTimeout(timer);
        if (offset === len) return buf.buffer;
        throw new Error(`incomplete download (${offset}/${len} bytes)`);
      }

      // No content-length / no readable stream → single buffer, indeterminate bar.
      setLoadingPreparing();
      const data = await resp.arrayBuffer();
      clearTimeout(timer);
      return data;
    } catch (e) {
      clearTimeout(timer);
      lastErr = controller.signal.aborted
        ? new Error(`Timed out after ${Math.round(opts.timeoutMs / 1000)}s`)
        : e;
      if (attempt < opts.attempts) {
        opts.onRetry(attempt, opts.attempts);
        await new Promise(r => setTimeout(r, 700 * attempt));
      }
    }
  }
  throw lastErr ?? new Error('download failed');
}

async function init() {
  // plan-267 F6: capture the #k= fragment secret and scrub it from the address
  // bar as the very first thing, before any network request or the Teams block
  // below reads window.location.hash.
  initFragmentSecret();

  // --- Microsoft Teams integration ---
  // When running inside a Teams tab (?teams=1), dynamically import the Teams JS SDK
  // so the iframe handshake completes and Teams shows the content.
  const isTeams = params.has('teams');
  if (isTeams) {
    try {
      const microsoftTeams = await import('@microsoft/teams-js');
      await microsoftTeams.app.initialize();
      logInfo('Teams SDK initialized');
      microsoftTeams.app.notifySuccess();

      // Extract Teams display name and inject as URL param for multiuser auto-join
      if (!params.has('name')) {
        try {
          const ctx = await microsoftTeams.app.getContext();
          const teamsName = (ctx as any)?.user?.userPrincipalName?.split('@')[0]
            ?? (ctx as any)?.user?.id?.slice(0, 8)
            ?? 'TeamsUser';
          params.set('name', teamsName);
          const newUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
          window.history.replaceState(null, '', newUrl);
          logInfo(`Teams user name: ${teamsName}`);
        } catch { /* context unavailable — no-op */ }
      }
    } catch (e) {
      console.warn('[main] Teams SDK init failed (running outside Teams?)', e);
    }
  }

  // --- Load App Config (MUST complete before React mount — no flicker) ---
  const appConfig = await fetchAppConfig();

  // URL param override for lockSettings (highest priority)
  if (params.has('lockSettings')) {
    appConfig.lockSettings = params.get('lockSettings') !== 'false';
  }

  // Perf test mode: suppress UI chrome
  const perfMode = params.has('perf');
  if (perfMode) {
    appConfig.lockSettings = true;
  }

  // Set singleton — from here all stores have access via getAppConfig()
  setAppConfig(appConfig);
  const connectEmbedEnabled = initializeConnectEmbedStore(appConfig);
  if (appConfig.sourceUrl) {
    const sourceLink = document.getElementById('rv-watermark');
    if (sourceLink instanceof HTMLAnchorElement) sourceLink.href = appConfig.sourceUrl;
  }

  // MU-accumulation kill-switch (plan-255 §2.8): settings.json
  // `simulation.accumulateDefault: false` disables the transport gap clamp
  // deployment-wide without re-exporting scenes.
  if (appConfig.simulation?.accumulateDefault === false) {
    const { RVTransportSurface } = await import('./core/engine/rv-transport-surface');
    RVTransportSurface.accumulateDefault = false;
  }

  // Surface-physics kill-switch (plan-276 Phase 4, F5 — accumulateDefault
  // pattern): settings.json `simulation.physicsSurfaceDefault: false` keeps
  // every TransportSurface kinematic (authored `PhysicsMode` flags ignored)
  // without re-exporting scenes. Narrower than `simulation.physicsEnabled`
  // below, which disables the whole physics-zone feature.
  if (appConfig.simulation?.physicsSurfaceDefault === false) {
    const { RVTransportSurface } = await import('./core/engine/rv-transport-surface');
    RVTransportSurface.physicsDefault = false;
  }

  // Physics-zones activation gate (plan-276 F10): settings.json
  // `simulation.physicsEnabled` (deployment-wide kill-switch, default true)
  // AND the localStorage `rv.physics` ACTIVATION toggle (Settings →
  // Simulation → "Physics (whole scene)", default OFF/opt-in), evaluated ONCE
  // at boot (load-time-only). The physics-zone plugin reads
  // `physicsSettings.enabled` BEFORE any lazy Rapier import; with the toggle
  // ON and no explicit WebPhysicsZone in the model it synthesizes a
  // WholeScene zone (F16).
  // F17 (Beta): `rv.physics.full` — full physics for ALL non-radial conveyors.
  // Strict AND semantics: only effective when the base gate above is open
  // (computeFullPhysics evaluates settings.json kill-switch AND `rv.physics`
  // AND `rv.physics.full`). Load-time-only like `enabled`.
  {
    const { physicsSettings, computePhysicsEnabled, computeFullPhysics } = await import('./core/engine/rv-physics-registry');
    physicsSettings.enabled = computePhysicsEnabled(appConfig.simulation?.physicsEnabled);
    physicsSettings.full = computeFullPhysics(appConfig.simulation?.physicsEnabled);
  }

  // Load shipped visual presets (public/presets/index.json). Non-blocking for
  // correctness — the preset picker re-reads on open — but awaited here so the
  // first Settings open already has them. Missing manifest → no-op.
  await loadPublishedPresets();

  // Fresh install: seed the initial visual preset so the viewer boots on it
  // (and the Visual-settings dropdown shows it) instead of "Custom". Weak
  // devices — mobile, or an integrated/software GPU per the standalone probe
  // (the renderer doesn't exist yet; antialias is a constructor-only param) —
  // get "Fast", everything else "Default", and the auto-quality modal informs
  // the user once. No-op once the user has saved visual settings. Must run
  // after loadPublishedPresets() (needs the preset list) and before the first
  // loadVisualSettings() below.
  if (!hasStoredVisualSettings()) {
    const initialQuality = chooseInitialQualityPreset();
    const seeded = seedInitialVisualPreset(initialQuality.name);
    if (seeded && initialQuality.name === FAST_PRESET_NAME && initialQuality.reason) {
      markAutoQualityApplied();
      queueAutoQualityNotice(initialQuality.reason);
    }
  }

  // --- Analytics consent gate ---
  // When a tracker is configured (settings.json analytics.googleAnalyticsId), GA
  // may not load without prior opt-in (GDPR / §25 TDDDG). Block boot until the
  // user accepts — without consent the app does not run. Private deploys with no
  // tracker id skip the gate entirely (this resolves immediately).
  await requireAnalyticsConsent();
  // Inject GA now that consent is in place (no-op when no id is configured).
  initAnalytics();

  // --- Bootstrap context-aware UI visibility (from settings.json `ui` key) ---
  {
    const uiCfg = appConfig.ui;
    // `embedded` — the page runs inside an iframe (plan-387 F5). Published as a
    // CONTEXT rather than queried directly in the component, so the rules that
    // depend on it stay overridable via `ui.visibilityOverrides` and testable
    // without a real iframe. Set before the overrides below so a deployment can
    // still redefine any rule that reads it.
    setContext('embedded', window.self !== window.top);
    // Activate initial contexts (e.g. "kiosk" mode)
    const initCtxs = Array.isArray(uiCfg?.initialContexts) ? uiCfg!.initialContexts : [];
    for (const ctx of initCtxs) {
      if (typeof ctx === 'string' && ctx) activateContext(ctx);
    }
    // Apply visibility overrides (override code-declared defaults)
    const overrides = (typeof uiCfg?.visibilityOverrides === 'object' && uiCfg?.visibilityOverrides !== null)
      ? uiCfg!.visibilityOverrides
      : {};
    for (const [id, rule] of Object.entries(overrides)) {
      if (rule && typeof rule === 'object') registerUIElement(id, rule);
    }
  }

  const app = document.getElementById('app')!;

  // Dedicated viewport container holding ONLY the WebGL canvas. It is full-bleed
  // by default; on desktop the HMI's <ViewportFrame> reactively insets it (left
  // for the activity bar + an open left window, right for an open right window)
  // so the 3D renders only in the central viewport region — never behind the
  // chrome. The renderer's ResizeObserver watches this container, so insetting it
  // resizes the canvas + camera aspect automatically. Loading overlay / watermark
  // stay on #app (full-screen), unaffected.
  const container = document.createElement('div');
  container.id = 'rv-viewport';
  container.style.cssText = 'position:fixed; inset:0;';
  app.appendChild(container);

  // --- Resolve antialias BEFORE renderer creation (constructor-only param) ---
  const initialSettings = loadVisualSettings();
  const wantAntialias = initialSettings.antialias !== false && !isTouchDevice;

  // Publish the HMI blur factor synchronously, here and not in initHMI (plan-344
  // Phase 2). Two reasons: it must be on `document.documentElement` (MUI portals
  // dialogs/menus/popovers into document.body, outside the HMI root), and it must
  // be set before the first paint — otherwise a user booting with the `Fast`
  // preset gets one frame at full 16px blur.
  applyUIBlurScale(initialSettings.uiBlurScale);

  // --- Create Viewer ---
  const viewer = await RVViewer.create(container, { renderer: rendererKind, antialias: wantAntialias, plannerSignalLinking: true });

  // Apply persisted DPR cap (runtime-changeable, no reload needed)
  viewer.maxDpr = initialSettings.maxDpr;

  // AAS resolvability is decided centrally and marked on the nodes. Installed on
  // the viewer (not only in AasLinkPlugin) because that plugin is not loaded in
  // every mode — the layout planner would otherwise leave links unclassified,
  // and unclassified means invisible (plan-373 F1/F2b).
  installAasResolution(viewer);

  // Apply persisted visual settings NOW — before any model load. This kicks
  // off the env-map (IBL) generation early so it overlaps with the GLB
  // download/parse instead of starting AFTER initHMI mounts the HMI and
  // its useEffect runs (which was the source of the "scene appears unlit,
  // then lighting kicks in" pop). Trackable via viewer.trackLoadingWork,
  // so `await viewer.loadModel(...)` waits for the IBL too.
  // The HMI's useApplyPersistedSettings still runs on mount; it's
  // idempotent for the same values and serves as a fallback if settings
  // change between boot and HMI mount.
  viewer.applyVisualSettings(initialSettings);

  // Expose viewer globally for console debugging
  (window as unknown as { viewer: RVViewer }).viewer = viewer;

  // --- Analytics: distinguish what the visitor views (no-op unless GA configured + consented) ---
  // Standard demo (model_view: DemoRealvirtualWeb) vs. Planner demo (workspace_mode: planner), etc.
  // trackAnalyticsEvent fires only when window.gtag exists, i.e. only after the consent gate granted.
  viewer.on('model-loaded', () => {
    const url = viewer.currentModelUrl ?? '';
    const model = url.split(/[?#]/)[0].split('/').pop()?.replace(/\.glb$/i, '') || 'unknown';
    trackAnalyticsEvent('model_view', { model });
  });
  viewer.on('mode-changed', ({ to }) => {
    trackAnalyticsEvent('workspace_mode', { mode: to });
  });

  // --- Register Industrial Interfaces ---
  const ifaceManager = new InterfaceManager();
  ifaceManager.register(new WebSocketRealtimeInterface());
  ifaceManager.register(new CtrlXInterface());
  ifaceManager.register(new MqttInterface());
  ifaceManager.register(new TwinCatHmiInterface());

  // --- Register Core Plugins ---
  viewer
    .use(ifaceManager, 'core')
    .use(new DriveOrderPlugin(), 'core')
    .use(new SensorMonitorPlugin(), 'core')
    .use(new TransportStatsPlugin(), 'core')
    .use(new CameraEventsPlugin(), 'core')
    .use(new AdaptiveNavPlugin(), 'core')
    .use(new CameraStartPosPlugin(), 'core')
    .use(new CameraFollowPlugin(), 'core')
    .use(new KioskPlugin(), 'core')
    .use(new MeasurementPlugin(), 'core')
    .use(new ClippingPlugin(), 'core')
    .use(new WebErrorPlugin(), 'core')
    .use(new CollisionAlertPlugin(), 'core')
    .use(new CustomRuntimeInstructionPlugin(), 'core')
    .use(new RvExtrasEditorPlugin(), 'core')
    .use(new ConnectPlugin(), 'core')
    // plan-386 R13: the shared-link info card only ever appears because of this
    // line. It is listed as its own roadmap step and covered by
    // `share_PluginRegistered` for exactly that reason.
    .use(new SharePlugin(), 'core')
    // plan-719 §2.4: the ONE renderer of the save dialogs. The store is a
    // singleton, so mounting its dialogs from `DocumentCard` — which hangs in
    // two places at once — would put two of every prompt on screen.
    .use(new SaveDialogsPlugin(), 'core')
    .use(new HistorianTrendPlugin(), 'core')
    .use(new OrientationGizmoPlugin(), 'core')
    .use(new LayoutPlannerPlugin(), 'core')
    .use(new SignalBindPlugin(), 'core')
    .use(new SnapPointPlugin(), 'core')
    .use(new SnapFlipIconOverlay(), 'core')
    .use(new SimControllerPlugin(), 'core')
    .use(new IKPathVisualizerPlugin(), 'core')
    .use(new PathVisualizerPlugin(), 'core')
    .use(new IKTargetEditPlugin(), 'core')
    .use(new DriveAxisGizmoPlugin(), 'core')
    .use(new DESWorkspacePlugin(), 'core')
    // WebComponent script components (plan-210, JS-in-GLB). Trust gate §10:
    // execution stays OFF unless ?scripts is passed (the phase-3 editor UI
    // adds the per-model confirmation flow / setAllowScripts API).
    .use(new WebComponentPlugin({ allowScripts: params.has('scripts') }), 'core')
    // Typed connections (plan-259): rv-ODT Connections block lifecycle,
    // StopOnExit dispatch + cable visualization (overlay category 'connections').
    .use(new ConnectionSystemPlugin(), 'core')
    .use(new ConnectionGizmoPlugin(), 'core');

  // --- Lazy Plugins (code-split, loaded on demand) ---
  viewer.registerLazy('gaussian-splat', () =>
    import('./plugins/gaussian-splat-plugin').then(m => ({ default: m.GaussianSplatPlugin }))
  );

  // --- Per-model plugin manager (loads model-specific plugins on model switch) ---
  // The manifest is the binding (plan-718 §2.6): the document row being loaded
  // names its own code. The lookup is injected rather than imported by the
  // manager, so the manager stays free of the project store — and so a test can
  // state the binding without one.
  viewer.modelPluginManager = new ModelPluginManager({
    scriptRefProvider: ({ modelUrl }) =>
      scriptRefForModelUrl(getProjectStore().getProject(), modelUrl),
    // Stage 2b: a project may carry its own compiled code. The source is the
    // ACTIVE backend of the moment (the open project changes under a long-lived
    // manager), and reading a file is all the manager is given — no write side.
    runtimeScriptSource: () => {
      const backend = getProjectStore().getBackend();
      return backend ? { readBytes: (rel: string) => backend.readBlobBytes(rel) } : null;
    },
    // …and it runs only with this project's persisted consent (2b.3, R8).
    runtimeScriptConsent: ({ scriptRef }) => {
      const project = getProjectStore().getProject();
      if (!project?.id) return false;
      return requestProjectCodeConsent({
        projectId: project.id,
        projectName: String(project.name ?? project.id),
        scriptRef,
      });
    },
  });

  // --- Performance test plugin (activated via ?perf URL param) ---
  if (params.has('perf')) {
    const { PerfTestPlugin } = await import('./plugins/demo/perf-test-plugin');
    viewer.use(new PerfTestPlugin(), 'core');
  }

  // --- Asset editor: NOT registered here (plan-434).
  // The GLB asset authoring UI is a COMMERCIAL feature living in the private
  // sibling (`@rv-private/plugins/asset-editor`). It registers itself — plugin
  // AND the Editor mode — through the `asset-editor` feature adapter, exactly
  // like every other licensed subsystem: customer tier in private-plugins.ts on
  // our machines, and the manifest-generated registration in a customer
  // workspace. Registering it from here as well would double-register it.
  // A community clone has no private sibling, so there is no editor and no
  // Editor mode entry — see the modes block below.

  // --- Unified CAD import (plan-238): "Import" button + provider registry.
  // Registers the core GLB-file provider; private providers (STEP, Asset
  // Manager, Onshape) add themselves in registerPrivatePlugins below.
  const { UnifiedImportPlugin } = await import('./plugins/unified-import');
  viewer.use(new UnifiedImportPlugin(), 'core');

  // --- Register Private Plugins (no-op in public build) ---
  // Awaited: internal-tier features load via a __RV_INTERNAL__-gated dynamic
  // import and must finish registering (modes, components) before the mode
  // registration below and the mode-boot block later in this function.
  await registerPrivatePlugins(viewer);

  // --- Smooth-motion provider gate (plan-281 Finding #14) ---
  // The jerk-limited drive core must be decided BEFORE the first model loads:
  // the backend may never change mid-profile, so a drive constructed while the
  // wasm is still in flight would be stuck on the trapezoidal ramp for its whole
  // life. Unlike the IK solver this is therefore explicitly awaited, not
  // fire-and-forget. A build without the provider resolves immediately (false)
  // and every smooth drive falls back with ONE warning per model.
  await smoothMotionRegistry.whenReady();

  // --- Workspace modes (plan-198): Viewer / HMI / DES / Planner / Commissioning / Editor ---
  // Registered after all plugins so the dropdown reflects the full set. The
  // active mode is applied AFTER the model loads (see mode-boot block below).
  // The Editor is `runtime: 'detached'`: the SimulationRuntime performs NO
  // time integration there (asset authoring, not simulation).
  //
  // The Viewer (plan-387) is the pure spectator workspace: model + kinematics,
  // Settings and the view/grouping controls — no authoring, no signals, no
  // panels. It keeps the DEFAULT `runtime: 'simulation'` on purpose (F2): the
  // kinematics must run, unlike the detached Editor. `order: 5` puts it first —
  // it is the simplest view and belongs at the top of the dropdown. The icon
  // name must exist in ModeDropdown's ICONS map or it silently falls back to the
  // generic Dashboard icon; `ViewInAr` is registered there.
  //
  // Commissioning (plan-423) is the Viewer's counterpart for virtual
  // commissioning: the same lean surface WITHOUT the operator HMI (no KPI
  // cards, no message stack, no views), but WITH the tools an integrator needs
  // to put a shared machine into operation — Inspector, Hierarchy, CONNECT and
  // the AI bridge. It keeps the default `runtime: 'simulation'` for the same
  // reason the Viewer does. `order: 35` places it between Planner (30) and
  // Editor (40) — a user decision, not a technical one.
  viewer.modes
    .register({ id: 'viewer', label: 'Viewer', icon: 'ViewInAr', order: 5 })
    .register({ id: 'hmi', label: 'HMI', icon: 'ViewQuilt', order: 10 })
    .register({ id: 'des', label: 'DES', icon: 'AccountTree', order: 20 })
    .register({ id: 'planner', label: 'Planner', icon: 'GridView', order: 30 })
    .register({ id: 'commissioning', label: 'Commissioning', icon: 'Handyman', order: 35 });
  // The Editor mode is registered by the asset-editor feature adapter (plan-434),
  // which runs inside registerPrivatePlugins above. A community build has no
  // editor, so the dropdown must not offer a mode that would open an empty shell.
  if (connectEmbedEnabled) attachConnectEmbedModeManager(viewer.modes);

  // ── The generic kiosk lock (plan-721 F5) ──────────────────────────────
  //
  // `settings.mode.lock` is the declared form of what CONNECT-embed and the
  // Mauser/Toray plugins do in code. It is applied HERE, immediately after the
  // modes are registered, and that placement is the whole contract:
  // `resolveResumeTarget` below reads `viewer.modes.lockedMode`, so a lock
  // applied later — in the model-plugin hook the project plugins use, which
  // fires AFTER the model has loaded — would be invisible to the resume rule.
  // The kiosk branch would then silently not apply and the boot would fall
  // through to the legacy catalogue resolution: exactly the failure this plan
  // exists to remove. `connect-embed-store` is the precedent to follow, the
  // project plugins are the counter-example.
  //
  // `lock()` itself ignores an unknown mode id with a warning, so a config
  // naming a mode this build does not register cannot strand the deployment.
  const configuredModeLock = lockedModeOf(appConfig);
  if (configuredModeLock) {
    viewer.modes.lock(configuredModeLock);
    debug('config', `Workspace locked to '${configuredModeLock}' by settings.json (mode.lock)`);
  }

  // --- Mode-driven highlight profiles (single policy point) ---
  // Applied on every 'mode-changed' (so it MUST exist before the mode-boot
  // block below restores the initial mode): HMI/DES = blue overlay fill+edges,
  // planner = green OutlinePass, editor = yellow OutlinePass. Plugins no
  // longer install/restore highlight styles themselves.
  const { RVHighlightPolicy } = await import('./core/engine/rv-highlight-policy');
  const { MODE_HIGHLIGHT_PROFILES } = await import('./core/engine/rv-highlight-profiles');
  viewer.highlightPolicy = new RVHighlightPolicy(viewer)
    .register('hmi', MODE_HIGHLIGHT_PROFILES.hmi)
    .register('des', MODE_HIGHLIGHT_PROFILES.des)
    .register('planner', MODE_HIGHLIGHT_PROFILES.planner)
    .register('editor', MODE_HIGHLIGHT_PROFILES.editor);

  // --- Auto-discover behaviors (src/behaviors/*.ts) ---
  // Each behavior file declares which GLB filenames it applies to via
  // `models[]` and gets a fresh bind context on every matching load.
  const { registerAllBehaviors } = await import('./core/behaviors');
  registerAllBehaviors(viewer.behaviors);

  // --- Model discovery ---
  //
  // ## The build-time glob is GONE (plan-735 F5)
  //
  // `import.meta.glob('/public/models/*.glb')` used to seed this list from
  // whatever GLBs happened to sit in the dev checkout's `public/models/`, and
  // that made it the ONLY thing declaring the reference model on two delivery
  // channels — which is how the viewer ended up inventing a project around
  // files nobody had published (`BundledBackend._syntheticManifest()`, also
  // gone). It also bundled the dev environment's models into every build, so a
  // private deploy had to blank the list again from `models.json` below.
  //
  // Every channel now says what it ships, in its own `project.json`, and the
  // catalogue below is filled only by things a DEPLOY actually serves:
  // `models.json`, the dev-only `/__api/private-models` endpoint, the local
  // working folder, and the CONNECT gateway. A deploy root that publishes none
  // of them has an empty catalogue and a manifest — not a glob's leftovers.
  //
  // `project` is set only for models discovered inside a private project folder
  // (dev). Deploy-root models carry none: a deploy IS one project.
  const entries: Array<{ filename: string; url: string; project?: string }> = [];

  // Discover private project models. `/__api/private-models` is served ONLY by
  // the dev-time Vite middleware (privateModelsPlugin); no deployed build serves
  // it, so the fetch is dev-only — gating it keeps the public/private builds from
  // logging a guaranteed 404 on every page load. (Deployed private projects swap
  // models in via the runtime `models.json` manifest below, not this endpoint.)
  if (import.meta.env.DEV) {
    try {
      const resp = await fetch('/__api/private-models');
      if (resp.ok) {
        const privateModels: Array<{ project: string; filename: string; url: string }> = await resp.json();
        for (const pm of privateModels) {
          // `project` is carried through: every private project's models come
          // down this one endpoint, and a model belongs to exactly one of them.
          // Dropping the tag here is what used to put Toray's and Mauser's GLBs
          // into the DemoRealvirtual project's Models list.
          entries.push({ filename: pm.filename, url: pm.url, project: pm.project });
        }
      }
    } catch { /* private models endpoint not available — ignore */ }
  }

  // Runtime model manifest (generated during private project staging, replaces build-time glob).
  // If present, the manifest is AUTHORITATIVE — the build-time glob bundles
  // /public/models/*.glb from the dev environment (e.g. DemoRealvirtualWeb.glb) into every
  // build, but private deploys swap out the models folder on the server. Keeping the
  // build-time entries around would leave stale filenames matchable by localStorage, causing
  // 404s when a returning user had previously opened a model that only exists in another deploy.
  try {
    const resp = await fetch(`${import.meta.env.BASE_URL}models.json`, { cache: 'no-store' });
    if (resp.ok) {
      const runtimeModels: string[] = await resp.json();
      entries.length = 0;
      for (const filename of runtimeModels) {
        entries.push({ filename, url: `${import.meta.env.BASE_URL}models/${filename}` });
      }
    }
  } catch { /* no manifest — use build-time discovery only */ }

  // Discover local working folder models (File System Access API, Chrome/Edge only)
  if (isFsApiSupported()) {
    try {
      const localFiles = await listSubfolderFiles('models', ['.glb']);
      for (const f of localFiles) {
        const blobUrl = await readFileAsUrl(f.handle);
        entries.push({ filename: f.name, url: blobUrl });
      }
    } catch { /* permission denied or handle expired — skip silently */ }
  }

  // Models published to a running CONNECT gateway (plan-365 §2.1). Laid over the
  // catalogue resolved above, never replacing it: `models.json` stays authoritative
  // where it exists, and the embedded models stay in the list (F8).
  //
  // Deliberately LAST and deliberately additive — this is the recovery path for
  // every publish this tab did not witness: a `model_changed` that arrived while
  // the browser was closed, or while the WebSocket was down, is picked up here on
  // the next load. A gateway-less deploy answers 404 and the catch below keeps the
  // boot silent, exactly as the `models.json` probe above already does.
  //
  // ## `manifest.models` is a FOREIGN catalogue, not a project manifest (plan-413 §2.6)
  //
  // plan-413 replaced `models[]`/`scenes[]`/`library[]` with one `documents[]`
  // list — in the manifests realvirtual WEB itself writes. This one it does not
  // write: `/model/manifest` is produced by the CONNECT gateway, a separate
  // program with its own release cycle, and the shape below is its published
  // contract. Renaming the field here would only mean reading a key nobody
  // sends. So this stays a compatibility ADAPTER: CONNECT's `models[]` is
  // translated into viewer catalogue entries at this boundary and the document
  // model begins on the other side of it. Same decision plan-397 took for the
  // plan-700/701 delivery manifests. If CONNECT ever speaks `documents[]`, the
  // change belongs here and nowhere else.
  // Probed only where a CONNECT gateway can actually be the page origin: the
  // embedded bundle (CONNECT serves the page), a loopback origin (local
  // gateway / dev), or any dev build (the Vite proxy forwards to the gateway,
  // remote-dev included). A static CDN deploy can never answer this route, and
  // the guaranteed 404 was a red line in every visitor's console (2026-08-31).
  const mayHaveGatewayOrigin = connectEmbedEnabled || isLoopbackOrigin() || import.meta.env.DEV;
  try {
    const resp = mayHaveGatewayOrigin
      ? await fetch('/model/manifest', { cache: 'no-store' })
      : null;
    if (resp?.ok) {
      const manifest: { models?: Array<{ name?: string; url?: string; revision?: string }> } =
        await resp.json();
      for (const model of manifest.models ?? []) {
        if (!model.url) continue;
        const url = canonicalModelUrl(model.url, import.meta.env.BASE_URL);
        const filename = model.name ?? modelFileName(url);
        // The revision the gateway reports is what makes a later download ask for
        // the current bytes instead of whatever the browser cached last week.
        setModelRevision(url, model.revision);
        if (!entries.some((e) => e.filename.toLowerCase() === filename.toLowerCase())) {
          entries.push({ filename, url });
        }
      }
    }
  } catch { /* no gateway on this origin — the build-time catalogue stands */ }

  // Expose discovered models to the HMI model selector.
  // A base entry may be expanded with selectable "model options" (supplier variants)
  // declared in a model folder's model-options.ts. An option entry reuses the SAME
  // GLB url plus an `?option=<id>` marker that the model plugin reads in onModelLoaded
  // to apply its manipulation (e.g. AAS remap) — no duplicate GLB, no build step.
  const optionModules = import.meta.glob('/src/plugins/models/*/model-options.ts', { eager: true }) as
    Record<string, ModelOptionsModule>;
  // Record every declared option id — listed AND deep-link-only — so the URL
  // contract knows which `?option=` a model understands (plan-373 F6).
  registerModelOptionModules(Object.values(optionModules));
  const optionsByModel = new Map<string, Array<{ id: string; label: string }>>();
  for (const mod of Object.values(optionModules)) {
    if (mod.baseModel && Array.isArray(mod.modelOptions) && mod.modelOptions.length > 0) {
      optionsByModel.set(mod.baseModel, mod.modelOptions);
    }
  }
  // Rebuild the selector list from `entries`. Extracted so a model published to a
  // running gateway can go through exactly the same expansion instead of a second,
  // slightly different construction of the same list (plan-365).
  function publishCatalog(): void {
    viewer.setAvailableModels(entries.flatMap((e) => {
      const baseLabel = e.filename.replace(/\.glb$/i, '');
      const base = { url: e.url, label: baseLabel };
      const opts = optionsByModel.get(baseLabel);
      if (!opts) return [base];
      const sep = e.url.includes('?') ? '&' : '?';
      return [
        base,
        ...opts.map((o) => ({ url: `${e.url}${sep}option=${o.id}`, label: `${baseLabel} (${o.label})` })),
      ];
    }));
  }
  publishCatalog();

  // ── Project resolution, half one (plan-372 §2.10) ─────────────────
  // Which project is active has to be known BEFORE `initSceneStore()`, but
  // the pre-existing `restoreLastProject()` needs an already-attached
  // SceneStore — a cycle. It is therefore split in two: this half resolves
  // the project and opens its backend READ-ONLY (no writer, no bus
  // subscription, nothing written), the second half runs after the attach.
  //
  // The bundled backend is fed the model list resolved above rather than
  // re-deriving it: `entries` alone comes from four deploy-specific paths,
  // and a second discovery implementation would eventually disagree with
  // this one. Feeding `entries` *from* the resolved project is the
  // browser/folder backends' job (Phase 2/3) — the invariant that matters here
  // is that the list still stands before the SceneStore constructor reads it.
  //
  // There is no second list any more. `publishedScenes` used to be handed in
  // beside it, discovered from `scenes/index.json` — the second catalogue and
  // the second identity space plan-731 melted into `documents[]`.
  // Remembered for the appliance boot verdict further down (plan-721 F8): WAS
  // this boot pointed at a served project, and did that URL actually answer
  // with a readable `project.json`? Both facts are established here and
  // nowhere else — re-deriving them later would mean a second fetch and a
  // second chance to disagree with what was actually resolved.
  let servedProjectUrl: string | null = null;
  let servedProjectManifestOk = false;

  try {
    // Only the demo project's own models. `viewer.availableModels` is the
    // deploy-wide selector list — in dev that includes every private customer
    // project — and handing it to the bundled backend would make each of those
    // GLBs a model *of* the demo project.
    const demoModelUrls = new Set(
      entries.filter(e => !e.project || e.project === DEMO_PROJECT_FOLDER).map(e => e.url),
    );
    const bundled = getProjectStore().getBundledBackend({
      models: viewer.availableModels
        .filter(m => demoModelUrls.has(m.url.split('?')[0]!))
        .map(m => ({ url: m.url, label: m.label })),
    });
    // ?project=<slug> is additive and resolves BEFORE ?scene= / ?model=
    // (plan-372 §2.11): those identify something *within* a project, so
    // resolving them first would look the id up in whichever project happened
    // to be restored from the last session.
    const urlParams = new URLSearchParams(window.location.search);
    const urlProject = urlParams.get('project');
    // ?projectUrl=<deploy root> opens a project published somewhere else,
    // read-only (plan-700 Phase 7 / F12). It resolves BEFORE ?project=, which
    // then selects within that deploy rather than within ours.
    const urlProjectRoot = urlParams.get('projectUrl');
    servedProjectUrl = urlProjectRoot;
    await getProjectStore().resolveActiveProject({
      bundledBackend: bundled,
      ...(urlProject ? { projectId: urlProject } : {}),
      ...(urlProjectRoot ? { remoteBaseUrl: urlProjectRoot } : {}),
    });
    // The backend is cached per base URL, so this is the SAME instance
    // `resolveActiveProject` just consulted — the flag, not a second fetch.
    if (urlProjectRoot) {
      servedProjectManifestOk =
        getProjectStore().getRemoteBackend(urlProjectRoot).hasDeployedManifest();
    }
  } catch (e) {
    console.warn('[main] Project resolution skipped:', e);
  }

  // ── Scene window: register, migrate any legacy autosave, build store ──
  // Migration runs once: if `rv-layout-autosave` exists from a previous session,
  // import it as an "Untitled Layout" entry in the new registry so users don't
  // lose their work. Idempotent on subsequent boots.
  migrateLegacyAutosave();
  const sceneStore = initSceneStore(viewer);

  // Attach here, not inside the project-restore branch below. Two of the three
  // boot paths (the CONNECT-only entry and the Firebase demo) never reach that
  // branch, and an unattached store makes `ProjectStore.hasUnsavedWork()` — now
  // the ONE answer to "is there unsaved work", including the unload guard's —
  // silently blind to the scene on exactly those paths. Attaching is two
  // assignments plus the hydrator; `hydrateScene()` with no project open reads
  // the cache or returns false, and writes nothing. What genuinely needs the
  // project is `hydrateProjectScenes()`, which stays where it was.
  getProjectStore().attachToSceneStore(sceneStore);

  // ── User plugin overrides: restore what the user switched off (plan-435) ──
  // Placed after the last `viewer.use()` and after project resolution, but
  // BEFORE any model load: a plugin the user switched off must never receive
  // an `onModelLoaded` it would immediately have to undo. Overrides for
  // plugins registered later (model plugins, DebugEndpoint, McpBridge) are
  // remembered by the viewer and applied in `use()`.
  {
    const resetPlugins = new URLSearchParams(window.location.search).get('resetPlugins');
    if (resetPlugins === '1') clearAllPluginOverrides();
    const scope = overrideScopeKey(
      getProjectStore().getProject()?.id ?? null,
      // No model is loaded yet, so the last-model key is the best stand-in for
      // "which model is about to open" when no project is active.
      (() => { try { return localStorage.getItem('rv-webviewer-last-model'); } catch { return null; } })(),
    );
    if (scope !== null) {
      viewer.applyPersistedPluginOverrides(loadPluginOverrides(scope));
      viewer.on('plugins-changed', (data: unknown) => {
        const kind = (data as { kind?: string } | null)?.kind;
        if (kind !== 'user-disabled' && kind !== 'user-enabled') return;
        savePluginOverrides(scope, viewer.getPersistedPluginOverrideIds());
      });
    }
  }

  // The ONE unload guard for the page. It replaces the asset editor's own,
  // which was installed in `_activate` and torn down in `_deactivate` — so it
  // asked in editor mode and nowhere else, and the case that loses the most
  // work went unasked: a shared link opens a TRANSIENT workspace, which by
  // design never autosaves, in viewer or planner mode. Someone who bound their
  // PLC signals to a shared demo and pressed F5 lost all of it in silence.
  //
  // Asks `hasUnpersistedWork()`, never `hasUnsavedWork()`: a normal workspace is
  // dirty most of the time and its autosave already carried it across the
  // reload. A dialog that appears when nothing is at stake is one the user
  // learns to click away, which is how a guard stops working.
  // DEV ONLY: a Vite full reload is not the user leaving the page. Editing a
  // .ts file that cannot be hot-patched makes Vite call location.reload(), the
  // guard below turns that into Chrome's "Reload site? Changes you made may not
  // be saved" modal, and the dev loop stops dead until a human clicks it — on
  // every such edit. Worse for an agent session: the modal is a NATIVE browser
  // dialog, so nothing in the page (and no MCP tool) can dismiss it, and every
  // web_* call blocks behind it until it times out.
  //
  // Vite announces the reload first, so the guard can stand down for exactly
  // that case. Nothing is risked: `import.meta.hot` exists only in dev, and the
  // draft autosave carries the document across the reload anyway — which is the
  // same reason this guard asks `hasUnpersistedWork()` and not `hasUnsavedWork()`.
  let viteFullReload = false;
  if (import.meta.hot) {
    import.meta.hot.on('vite:beforeFullReload', () => { viteFullReload = true; });
    // A failed/aborted reload must not leave the guard disarmed for good.
    import.meta.hot.on('vite:error', () => { viteFullReload = false; });
  }

  window.addEventListener('beforeunload', (e) => {
    if (viteFullReload) return;
    if (!getProjectStore().hasUnpersistedWork()) return;
    e.preventDefault();
  });

  // --- Load model helper ---
  // `options.overlay` carries the materialised rv-extras overrides from
  // loadScene(); it MUST be forwarded to viewer.loadModel so overrides are
  // applied to the GLB during traversal. Dropping it here was why saved drafts
  // reloaded with the original GLB values instead of the edited ones.
  // Remember the last requested model so the error overlay's Retry button can
  // re-run it after a failure.
  let lastLoadRequest: { url: string; options?: { overlay?: RVExtrasOverlay } } | null = null;

  async function loadModel(
    url: string,
    options?: { overlay?: RVExtrasOverlay; identityUrl?: string; data?: ArrayBuffer },
  ) {
    // `url` is where the bytes come from; `identityUrl` (set by loadScene when a
    // workspace resumed from a stored body) is which model they ARE. They differ
    // only on that path, where `url` is a `blob:` with a random UUID. Deriving
    // identity from it put that UUID in the loading overlay, in LS_KEY_MODEL and
    // — the visible damage — into the model-plugin lookup, so a drafted demo
    // scene reloaded without a single one of its HMI plugins.
    const identityUrl = options?.identityUrl ?? url;
    const matchedEntry = entries.find((entry) => entry.url === identityUrl);
    const modelIdentity = matchedEntry?.filename ?? identityUrl;
    const modelName = matchedEntry?.filename.replace(/\.glb$/i, '')
      ?? (identityUrl.split('/').pop() ?? identityUrl).split('?')[0].replace(/\.glb$/i, '');
    lastLoadRequest = { url, options };
    if (!connectEmbedEnabled) {
      showLoadingOverlay(modelName);
      localStorage.setItem(LS_KEY_MODEL, identityUrl);
    }

    try {
      const loadStart = performance.now();

      // Download into a single buffer with progress, timeout and retries (see
      // downloadGlb). The bytes are handed to the parser directly — no blob URL,
      // no double-buffering. 90 s timeout suits large GLBs on slow mobile links.
      // `modelFetchUrl` appends `?v=<revision>` when a publish has been announced
      // for this model, and returns the URL untouched otherwise. Only the DOWNLOAD
      // sees that variant: a publish overwrites the same URL, so without it the
      // browser answers from cache and the user keeps seeing the previous geometry
      // — while `url` itself stays the model's identity everywhere else (the
      // catalogue key, the localStorage entry and the scene-draft key are all this
      // one string, and a `?v=` in it would match none of them again).
      // Bytes handed in by the caller skip the download entirely (plan-709
      // §2.5): a project asset resolved straight out of the backend has nothing
      // to fetch, and its `rvproject:` name is not a fetchable URL at all.
      let data = options?.data ?? await downloadGlb(modelFetchUrl(url), {
        attempts: 3,
        timeoutMs: 90_000,
        onRetry: setLoadingRetrying,
      });

      // plan-267: an encrypted deploy ships the GLB as an RVE1 envelope under its
      // normal .glb name (self-describing via magic). Show the password gate and
      // decrypt BEFORE parsing — the model never reaches GLTFLoader.parse until
      // the password is correct.
      if (isEncryptedEnvelope(new Uint8Array(data))) {
        data = await decryptModelData(data);
      }

      const sizeMB = (data.byteLength / (1024 * 1024)).toFixed(1) + ' MB';

      viewer.pendingModelUrl = identityUrl;

      // Download done — the parse + scene build below is the long pole with no
      // byte progress. Show the preparing state.
      if (!connectEmbedEnabled) setLoadingPreparing();

      const result = await viewer.loadModel(url, { ...options, data, modelName: modelIdentity, identityUrl });

      // Keep the original URL (model selector matches against it).
      viewer.currentModelUrl = identityUrl;

      // Mark GLB scene active in the scene store (for the Scene window).
      // We re-derive the label so saved-from-localStorage entries stay
      // consistent with the discovered manifest.
      const label = matchedEntry ? matchedEntry.filename.replace(/\.glb$/i, '') : modelName;
      // markGlbActive synthesizes a fresh draft RvScene on the new base —
      // viewer.currentScene is updated via that call.
      if (!connectEmbedEnabled) sceneStore.markGlbActive(identityUrl, label);

      const loadTime = ((performance.now() - loadStart) / 1000).toFixed(1) + 's';
      viewer.lastLoadInfo = { glbSize: sizeMB, loadTime };
      logInfo(`Model loaded: ${sizeMB}, ${loadTime}, ${result.drives.length} drives`);
      hideLoadingOverlay();
      if (getConnectEmbedSnapshot().state === 'loading') completeConnectEmbedDemoLoad();
      return { ok: true } as const;
    } catch (e) {
      // A SUPERSEDED load is not a failure (plan-442). Picking a second model
      // while the first is still parsing rejects the first with
      // `LoadAbortedError` — the newer load owns the scene and its own overlay,
      // so reporting this one would put an error over a perfectly good model.
      if (e instanceof LoadAbortedError) return { ok: false, error: 'superseded' } as const;
      // Surface the failure instead of leaving a silent empty scene. On mobile the
      // console is invisible, so without this the user just sees a blank viewer.
      console.error(`[main] Failed to load model: ${url}`, e);
      const reason = e instanceof Error ? e.message : String(e);
      if (connectEmbedEnabled) {
        hideLoadingOverlay();
        failConnectEmbedDemoLoad(reason);
      } else {
        showLoadingError(`${reason}\n${url}`);
      }
      return { ok: false, error: reason } as const;
    }
  }

  // Expose loadModel with progress overlay so Settings > Model can use it
  viewer.loadModelWithProgress = loadModel;

  // ── Published models (plan-365) ───────────────────────────────────────
  // One coordinator for the whole page. The WebSocket clients — the one in the
  // InterfaceManager, the per-model one inside ConnectPlugin, and ctrlX, which
  // inherits the handler — only report that a model was published; what that
  // means is decided here, once.

  const MODEL_UPDATE_HINT_ID = 'rv-model-updated';

  /**
   * Whether anything unsaved would be lost by reloading the model (F5).
   *
   * Delegates rather than deciding: this used to ask the scene store and the
   * asset editor's single document, which quietly under-reported once a
   * document STACK could be three frames deep with two of them dirty (and never
   * saw a queued folder write at all). `ProjectStore.hasUnsavedWork()` is the
   * one aggregation of those terms; a second, thinner copy of the same question
   * is how the two answers drift apart.
   */
  function hasUnsavedWork(): boolean {
    return getProjectStore().hasUnsavedWork();
  }

  /**
   * Reload the open model's geometry in place.
   *
   * Which route depends on the workspace: a scene carries overlay edits, planner
   * placements and op-created nodes that a bare `loadModel()` would drop on the
   * floor, so a scene-backed workspace is re-applied as a scene. The view is
   * captured before and restored after either way — both routes re-fit the camera
   * to the freshly loaded bounds, which is right when opening something and wrong
   * when the same model just got new bytes.
   */
  async function reloadPublishedModel(): Promise<void> {
    const view = captureViewState(viewer);
    const scene = sceneStore.getSnapshot().draft ?? viewer.currentScene;
    const url = viewer.currentModelUrl;
    try {
      if (scene && scene.base.kind === 'builtin') {
        await viewer.loadScene(scene);
      } else if (url) {
        await loadModel(url);
      }
    } finally {
      restoreViewState(viewer, view);
      hideInstruction(MODEL_UPDATE_HINT_ID);
    }
  }

  installModelUpdateCoordinator(new RVModelUpdateCoordinator({
    baseUrl: import.meta.env.BASE_URL,
    getCatalog: () => viewer.availableModels,
    setCatalog: (merged) => {
      // Feed `entries` rather than the expanded list: it is what `loadModel` and
      // the boot-time model resolution match against, and `publishCatalog()`
      // re-runs the supplier-variant expansion from it.
      for (const entry of merged) {
        const filename = modelFileName(entry.url);
        if (!entries.some((e) => e.filename.toLowerCase() === filename.toLowerCase())) {
          entries.push({ filename, url: entry.url });
        }
      }
      publishCatalog();
    },
    getCurrentModelUrl: () => viewer.currentModelUrl,
    hasUnsavedChanges: hasUnsavedWork,
    reloadCurrentModel: reloadPublishedModel,
    showReloadHint: (hint) => {
      // Not a `window.confirm` (repo convention) and not auto-dismissed: a hint
      // that disappears on its own is a hint the user can miss, and the choice it
      // offers — discard the edits or keep them — is theirs to make in their time.
      showInstruction({
        id: MODEL_UPDATE_HINT_ID,
        text: `"${hint.label}" was updated on the server. Reloading it discards your unsaved changes.`,
        anchor: { kind: 'edge', edge: 'top' },
        style: 'warning',
        source: 'model-update',
        dismissible: false,
        actions: [
          {
            label: 'Reload and discard changes',
            variant: 'primary',
            onClick: () => { hideInstruction(MODEL_UPDATE_HINT_ID); hint.onReload(); },
          },
          {
            label: 'Keep my changes',
            onClick: () => { hideInstruction(MODEL_UPDATE_HINT_ID); hint.onKeep(); },
          },
        ],
      });
    },
  }));

  // The Scene panel keeps its own copy of the catalogue, so it has to be told.
  // The login gate's picker rides on the catalogue signal inside setAvailableModels.
  viewer.on('models-changed', () => sceneStore.refreshGlbList());

  // --- Error overlay actions ---
  // Retry re-runs the last requested load; Reload is the hard fallback (also the
  // recovery path for a lost WebGL context, which cannot be re-initialised in place).
  loadingRetryBtn.onclick = () => {
    if (lastLoadRequest) loadModel(lastLoadRequest.url, lastLoadRequest.options);
  };
  loadingReloadBtn.onclick = () => window.location.reload();

  // A lost WebGL context (mobile GPU memory pressure, long-backgrounded tab)
  // leaves a permanently blank canvas. Surface it with a reload prompt.
  viewer.on('renderer-context-lost', () => {
    showLoadingError('The 3D graphics context was lost (often low memory on mobile). Reload to recover.');
  });

  // Preferred workspace mode declared by the opened document's MANIFEST ROW
  // (`mode`) — applied in the mode-boot block below (unless ?mode= overrides it).
  // Lets a bare legacy `?scene=published:<name>` reload/share restore the right
  // mode (e.g. planner) without relying on the URL carrying ?mode= or on
  // localStorage persistence. Read from `documents[]` since plan-731; it used to
  // come from the `scenes/index.json` catalogue that plan abolished.
  let publishedBootMode: string | null = null;

  // The mode half of the resumed session (plan-703 decision 24) — set by the
  // resume block below and applied in the same mode-boot chain. The mode
  // follows the SESSION, and the session is per project, so this beats the
  // globally persisted `modes.restore()` answer: reopening project A must not
  // land in the mode project B was last edited in.
  let resumeBootMode: string | null = null;

  // The active project is a library source, on every boot path (plan-372 §2.6.4).
  //
  // Installed HERE — before the branch below and before any `await` — rather
  // than inside the project-restore block it used to live in. Two failures
  // followed from that placement: a throw anywhere in the restore skipped the
  // installation entirely and left the Assets tab permanently empty for the
  // session, and the CONNECT-embed / Firebase-demo branches never reached it at
  // all. The provider subscribes to the store and refreshes itself on every
  // project switch, so installing it early costs nothing and needs no project.
  installProjectLibraryProvider(getProjectStore());

  // The global catalogs (URL / GitHub / local folder / bundled) are library
  // sources too (plan-702 Phase 0). Without this bridge they live only in
  // `LibraryStore` and never reach the registry, which is what left the
  // Assets tab able to show the project's own library and nothing else.
  installGlobalLibraryProvider(getLibraryStore());

  // … and the user's own subscriptions come BACK here, not in the Layout
  // Planner. `restoreFromStorage` had exactly one caller: the planner plugin's
  // activation. Since the Add-Library verb moved to the Projects dashboard
  // (plan-702), a library added there was written to localStorage and then
  // never read again unless the user happened to open the planner in the next
  // session — which reads, from the dashboard, as "I added it, it was there,
  // and after a reload it was gone". Restoring belongs to the store's owner.
  //
  // Deliberately NOT awaited: it fetches every subscribed catalog, and a slow
  // or unreachable one must not hold up the first frame. Each catalog paints
  // its root as it lands. The planner still calls it on activation; a second
  // call is a no-op per URL (`addCatalog` early-returns on a known URL).
  void getLibraryStore().restoreFromStorage();

  // A project's `libraries[]` follow the ACTIVE PROJECT, not just the boot.
  // `applyProjectLibraries` had a single call site below, inside the restore
  // block, so the manifest was read exactly once per page load: switching to
  // another project mid-session kept the previous project's libraries and
  // never picked up the new one's. Barely visible while a manifest library was
  // something you hand-edited; plainly wrong now that the Projects dashboard
  // ADDS libraries to the open project. Subscribing here rather than in the
  // dashboard covers every route into a project switch, not just that screen.
  //
  // Keyed on the URL list itself, not the project id: re-applying the same
  // list is not free (it re-reads the manifest rows and re-notifies), and an
  // add made through the dashboard already applied its own change.
  let appliedLibraries = '';
  const syncProjectLibraries = (): void => {
    const urls = readProjectLibraries(getProjectStore().getProject());
    const signature = JSON.stringify(urls);
    if (signature === appliedLibraries) return;
    appliedLibraries = signature;
    void getLibraryStore().applyProjectLibraries(urls);
  };
  getProjectStore().subscribe(syncProjectLibraries);

  // "Shared with me" — the bookmarks a visitor kept from shared links, shown as
  // one library tab (plan-386 §2.9). Installed unconditionally because the tab
  // has to be there on the NEXT visit too, when nothing was shared this session
  // but the bookmarks from last time still exist (F13).
  setSharedBookmarkHost(getLibraryStore());

  // --- Firebase demo mode: /demo/webviewer/{demoName} ---
  const pathParts = window.location.pathname.split('/').filter(p => p);
  const webviewerIdx = pathParts.indexOf('webviewer');
  const firebaseDemoName = webviewerIdx >= 0 && pathParts[webviewerIdx + 1] ? pathParts[webviewerIdx + 1] : null;

  if (connectEmbedEnabled) {
    // CONNECT public-demo is intentionally model-empty on every boot. This
    // single branch suppresses every URL, Firebase, saved-scene, persisted
    // model, configured-default and entries[0] restore path below.
    hideLoadingOverlay();
    viewer.leftPanelManager.open('connect', getStoredConnectPanelWidth());
  } else if (firebaseDemoName) {
    const bucketName = 'realvirtual-files.firebasestorage.app';
    const storagePath = `demo/webviewer/${firebaseDemoName}/demo.glb`;
    const firebaseGlbUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media`;
    debug('config', `Firebase demo: "${firebaseDemoName}" → ${firebaseGlbUrl}`);
    document.title = `${firebaseDemoName} - realvirtual WEB`;
    loadModel(firebaseGlbUrl);
  } else {
    // ── Project restore (plan-370 §4b boot mount point) ───────────────
    // Awaited BEFORE any scene/model routing. `openProjectFolder()` is
    // async I/O; without an explicit gate here the boot would first load
    // the default/URL model and then visibly jump to the project's active
    // scene. Hydration seeds the active scene and its `rv-scenes/active`
    // pointer, so the existing routing below picks it up unchanged.
    // Entirely a no-op when no project was open last session — the
    // non-project boot path is bit-for-bit what it was.
    try {
      const projectStore = getProjectStore();
      // (The store is attached at construction now — see there for why.)
      // Half two (plan-372 §2.10): reconciliation, the conflict prompt, the
      // dirty guard, lazy hydration — and `activate()`, the first point in
      // the whole boot at which anything may be written to disk. It needs the
      // attached store, which is why it cannot move up to half one.
      await projectStore.hydrateProjectScenes();
      // The manifest's `libraries[]` become project-level catalogs (§2.6.3).
      // The project's OWN library/ folder is a separate mechanism — the
      // provider installed above — and needs nothing here.
      //
      // Awaited here, and kept in sync from here on by the subscription above:
      // `subscribe` does not fire on subscribe, so the first project still
      // needs this call. The signature guard makes the pair idempotent.
      const bootLibraries = readProjectLibraries(projectStore.getProject());
      appliedLibraries = JSON.stringify(bootLibraries);
      await getLibraryStore().applyProjectLibraries(bootLibraries);

      // The plan-397 phase-7 op-log→GLB conversion used to run here. It is gone
      // with the rest of the JSON scene reader (plan-413 phase 6): a stored
      // op-log record now gets the F10 error from `rv-scene-storage.readScene`,
      // naming the release that can still convert it.
    } catch (e) {
      console.warn('[main] Project restore skipped:', e);
    }

    // ── URL routing for the unified Scene model ───────────────────────
    // ?scene=<id>             → open a saved scene by id (highest priority)
    // ?scene=builtin:<file>   → open a built-in by filename match
    // ?scene=empty            → fresh empty scene
    // ?glb=<url> | ?glb=s:<id> → shared, untrusted GLB (plan-386)
    // ?model=<url>            → legacy alias (handled below)
    // A sender coming back from the share sign-in mail arrives with
    // `?sharetoken=<one-time token>` (plan-386 §2.6). Redeem it and take it out
    // of the address bar — a one-time token that stays in a URL gets copied,
    // bookmarked and forwarded, and it is a credential. Deliberately not
    // awaited: without the parameter it makes no request at all, and the boot
    // has no business waiting on mail infrastructure.
    void consumeMagicLinkFromUrl();

    let sceneRouted = false;
    const urlGlb = params.get('glb');
    // ?doc=<documentId> — the one open verb (plan-716 §2.5, F5).
    //
    // Read here and routed AFTER `?scene=`, which is not an accident: the alias
    // redirect below rewrites an old `?scene=scn_…` to `?doc=` and opens it in
    // the same turn, so letting `?doc=` win first would make an old bookmark
    // resolve against a parameter that is not there yet. Both end in the same
    // `openDocument` call.
    const urlDoc = params.get('doc');
    // ?mode=planner boots a fresh empty scene (unless an explicit ?scene/?model
    // is given) so a published link drops the user straight into layout authoring.
    //
    // plan-386 Finding 15: `?glb=` has to be in that exclusion list too. It was
    // not, and the consequence was silent — `?glb=…&mode=planner` synthesised
    // `scene=empty`, the empty scene won on precedence, and the shared content
    // the whole link existed for never arrived. Covered by
    // `share_GlbWithPlannerMode_NotOverriddenByEmpty`.
    //
    // 2026-08-31: `?doc=` joined the list for the identical reason — the
    // planner demo's own link is `?doc=…&mode=planner`, and the synthesised
    // empty scene silently outranked the document it pointed at.
    const plannerMode = params.get('mode') === 'planner';
    const urlScene = params.get('scene')
      ?? (plannerMode && !params.get('model') && !urlGlb && !urlDoc ? 'empty' : null);
    if (urlScene) {
      try {
        if (urlScene === 'empty') {
          // Resume the autosaved per-base draft if there is one (mirror of
          // openBuiltin's resume semantics). `newEmpty()` would discard it —
          // that's reserved for the explicit "New empty scene" UI gesture.
          await sceneStore.openEmpty();
          hideLoadingOverlay();
          sceneRouted = true;
        } else if (urlScene.startsWith('builtin:')) {
          const wanted = decodeURIComponent(urlScene.slice('builtin:'.length));
          const match = entries.find(e => e.filename === wanted || e.url === wanted || e.url.endsWith(`/${wanted}`));
          if (match) {
            const label = match.filename.replace(/\.glb$/i, '');
            // Carry a top-level `?option=` into the model url so a deep link like
            // `?scene=builtin:DemoRealvirtualWeb.glb&option=bosch` still reaches
            // ModelOptionPlugin. Unknown options are ignored here and dropped from
            // the address bar by the scene store (plan-373 F6).
            await sceneStore.openBuiltin(withOptionParam(match.url, label, params.get('option')), label);
            hideLoadingOverlay();
            sceneRouted = true;
          }
          // No match — fall through to default model resolution below.
        } else if (urlScene.startsWith('published:')) {
          // ── A legacy ?scene=published:<name> link (plan-731 Phase 2) ────────
          //
          // `published:<urlName>` was the SECOND document identity space: its own
          // catalogue (`scenes/index.json`), its own open verb and its own row
          // highlight, all standing beside `stableDocumentId(path)`. plan-731
          // melted it down — the examples are ordinary `documents[]` rows now,
          // and this token survives only as an ALIAS onto one of them.
          //
          // What used to decide here was the catalogue; what decides now is the
          // MANIFEST, which is the same authority `?doc=` answers to. A name the
          // manifest does not carry falls through to the default boot chain,
          // exactly as an uncatalogued name used to — the outcome is unchanged,
          // only the source of truth moved.
          //
          // The address bar is normalised to `?doc=` for the same reason the
          // `scn_` alias branch below does it: a re-share or a bookmark should
          // carry the identity this build actually mints, and `replaceState`
          // keeps the old URL out of the Back button.
          const doc = resolvePublishedSceneParam(
            urlScene, documentsOf(getProjectStore().getProject()),
          );
          if (doc) {
            window.history.replaceState(
              {}, '', sceneUrlToDocumentUrl(window.location.href, doc.id),
            );
            await sceneStore.openDocument(doc.id, { name: doc.name });
            // Restore the example's preferred workspace mode (e.g. planner) from
            // its manifest row, so a shared/reloaded legacy link lands in the
            // right mode even without ?mode= in the URL. An explicit ?mode=
            // still wins (see the mode precedence block further down).
            if (typeof doc.mode === 'string' && doc.mode) publishedBootMode = doc.mode;
            hideLoadingOverlay();
            sceneRouted = true;
          }
          // Not a document of this project — fall through to default resolution.
        } else if (resolveSceneRoute(urlScene, documentsOf(getProjectStore().getProject()))) {
          // ── An old ?scene=scn_… link for a converted scene (plan-716 §2.4) ──
          //
          // The alias map is guaranteed to exist here: the migration runs awaited
          // inside `resolveActiveProject()`, which is above this line by the §2.3
          // boot anchor. The address bar is normalised to `?doc=` so a re-share,
          // a bookmark or a reload carries the new identity — and `replaceState`,
          // not `pushState`, because the old URL is not a place the Back button
          // should return to.
          //
          // Phase 3 (§2.5): what opens it is now the open VERB itself. The
          // redirect above is unchanged — the address bar is normalised first —
          // and `openDocument` is what the normalised URL would have reached on
          // the next reload anyway, so a converted link and a fresh `?doc=` link
          // are the same code path from here on.
          const route = resolveSceneRoute(urlScene, documentsOf(getProjectStore().getProject()))!;
          window.history.replaceState(
            {}, '', sceneUrlToDocumentUrl(window.location.href, route.documentId),
          );
          if (route.kind === 'document') {
            await sceneStore.openDocument(route.documentId, { name: route.name });
            hideLoadingOverlay();
            sceneRouted = true;
          } else {
            // Aliased, but not a row in the ACTIVE project's manifest. Not yet
            // "gone" (plan-726 follow-up): the boot's active project is the
            // deploy's own — the demo, on our deploys — while the migration's
            // documents live in "My Workspace". `openScene` carries the
            // cross-project hop for exactly this case: it re-resolves the
            // alias, asks the workspace manifest, switches when it owns the
            // row, and throws only when the document is genuinely nowhere.
            // Only then is "converted but gone" the honest answer.
            try {
              await sceneStore.openScene(urlScene);
              hideLoadingOverlay();
              sceneRouted = true;
            } catch {
              console.warn(`[main] ${urlScene} was converted to ${route.documentId}, which no longer exists.`);
              hideLoadingOverlay();
              reportMissingDocument(route.documentId);
              openProjectsDashboard();
              sceneRouted = true;
            }
          }
        } else {
          // Treat as a saved scene id. Guard against a huge auto-loaded part.
          if (await guardHeavyRestore(urlScene)) {
            await sceneStore.openScene(urlScene);
            hideLoadingOverlay();
            sceneRouted = true;
          }
          // else: user chose empty/clear → fall through to the default boot.
        }
      } catch (e) {
        console.warn(`[main] Failed to open ?scene=${urlScene}:`, e);
        // Fall through to default model resolution.
      }
    }

    // ── ?doc=<documentId> — the one open verb (plan-716 §2.5, F5) ─────────
    //
    // Every owned artefact is a document, so this is what a shared link, a
    // bookmark and a reload all carry from Phase 3 onwards. It is alias-tolerant
    // through `openDocument`, so even a `?doc=scn_…` — which nothing writes, but
    // which a hand-edited URL can produce — lands on the right row.
    //
    // A document id the manifest does not list is NOT a fall-through: the boot
    // has a project open and that project says the row is gone, so the honest
    // answer is to say so and show the list, exactly as the alias `missing`
    // branch above does. Falling through would silently boot the demo instead.
    if (!sceneRouted && urlDoc) {
      try {
        await sceneStore.openDocument(urlDoc);
        hideLoadingOverlay();
        sceneRouted = true;
      } catch (e) {
        console.warn(`[main] Failed to open ?doc=${urlDoc}:`, e);
        hideLoadingOverlay();
        reportMissingDocument(urlDoc);
        openProjectsDashboard();
        sceneRouted = true;
      }
    }

    // ── ?glb= — a shared GLB from a host we do not control (plan-386 §2.5b) ──
    //
    // Precedence: `?scene=` > `?glb=` > `?model=`. Setting `sceneRouted` here
    // is what skips BOTH the legacy model resolution below AND the
    // active-saved-scene resume — a link somebody sent must not open in the
    // visitor's last scene.
    //
    // Note what this branch does NOT call: `loadModel()` (the hull above, which
    // writes LS_KEY_MODEL and marks a GLB active) and `sceneStore.openBuiltin()`
    // (which persists a draft). It goes through `viewer.loadModel()` directly —
    // see rv-share-boot.ts for why that is the binding architecture, not taste.
    if (!sceneRouted && urlGlb) {
      // Fill the Phase-1 resolver seam: `?glb=s:<id>` is answered by the share
      // backend (plan-386 §2.6). Installed here rather than at module scope so
      // a build that never sees a shared link never registers anything.
      installShareIdResolver();
      const outcome = await bootSharedGlb(viewer, urlGlb);
      hideLoadingOverlay();
      if (outcome.ok) {
        sceneRouted = true;
      } else {
        // The card carries the sentence; the console line is for us. A failed
        // shared link still falls through to the normal boot so the visitor
        // lands in a working viewer rather than on a blank page.
        console.warn(`[main] Shared link could not be opened: ${outcome.error}`);
      }
    }

    // Model priority: URL param > last opened (localStorage, if still available) > settings.json defaultModel > first model.
    // The user's last choice wins over the deployer's default — `defaultModel` only kicks in on first visit
    // (empty localStorage) or when the saved model no longer exists in the manifest (e.g. after a deploy removed it).
    const urlModel = params.get('model');
    // The PROJECT's own start document outranks the global `settings.json` one
    // — the same merge `resolveResumeTarget` is fed above, and the same rule
    // plan-721 established for the appliance (plan-726 Phase 2).
    //
    // Reaching this line at all means the project-shaped resolution above did
    // NOT route: either the manifest names no start document, or it names one
    // that is not among its `documents[]`. The legacy resolution below is the
    // right answer for both, and it resolves a bare filename or a `models/`
    // path against the discovered catalogue rather than against the manifest —
    // which is exactly what a deploy whose manifest is missing or unreadable
    // needs (F11).
    const configModel = projectStartDocument(getProjectStore().getProject())
      ?? appConfig.defaultModel;
    const savedModel = localStorage.getItem(LS_KEY_MODEL);

    // Resolve configModel: match against discovered entries, or build a URL from filename/path
    let resolvedConfigModel: string | null = null;
    if (configModel) {
      // Matched on the bare filename too: the demo models are served from the
      // DemoRealvirtual project mount in dev (`/private-models/…`) and from
      // `models/` in a deploy, so a `models/X.glb` setting must find either.
      const configBase = configModel.split('/').pop();
      const match = entries.find((e) =>
        e.url === configModel || e.filename === configModel || e.filename === configBase);
      if (match) {
        resolvedConfigModel = match.url;
      } else {
        // Not in build-time manifest — resolve relative to BASE_URL (e.g. private deploy with swapped models)
        const isAbsoluteOrUrl = configModel.startsWith('http') || configModel.startsWith('/');
        resolvedConfigModel = isAbsoluteOrUrl
          ? configModel
          : `${import.meta.env.BASE_URL}${configModel.startsWith('models/') ? '' : 'models/'}${configModel}`;
      }
    }

    // Match saved model by URL or by filename (handles base path changes).
    // Only matches if the saved model is ACTUALLY available in this deploy — a user that
    // previously visited another deploy (or an older version of this one) gets fresh defaults
    // from settings.json instead of a 404 on a stale localStorage value.
    const savedEntry = savedModel
      ? entries.find((e) => e.url === savedModel || e.filename === savedModel.split('/').pop())
      : null;
    if (savedModel && !savedEntry) {
      debug('config', `Saved model "${savedModel}" not available in this deploy — falling back to settings.json defaultModel`);
      localStorage.removeItem(LS_KEY_MODEL);
    }

    let modelToLoad = urlModel
      ?? savedEntry?.url
      ?? resolvedConfigModel
      ?? null;

    // A top-level `?option=<id>` deep link (e.g. `?model=…&option=sew`) is folded
    // into the model URL so the selector, localStorage and currentModelUrl all carry
    // the variant. ModelOptionPlugin and the demo HMI also read it straight from the
    // page URL, so this is belt-and-suspenders for reload/selector consistency.
    const urlOption = params.get('option');
    if (modelToLoad && urlOption && !/[?&]option=/.test(modelToLoad)) {
      modelToLoad += (modelToLoad.includes('?') ? '&' : '?') + 'option=' + encodeURIComponent(urlOption);
    }

    // Defense-in-depth: if no `?scene=` param and a saved scene was active
    // last session (rv-scenes/active), resume it. This covers the path
    // where the user opened a saved scene from the panel — that flow now
    // also writes `?scene=`, but reload-after-save without URL refresh,
    // bookmarks predating the URL-write fix, or future code paths that
    // forget to update the URL still recover here.
    if (!sceneRouted) {
      try {
        const activeId = readActiveId();
        if (activeId && await guardHeavyRestore(activeId)) {
          await sceneStore.openScene(activeId);
          hideLoadingOverlay();
          sceneRouted = true;
        }
      } catch (e) {
        console.warn('[main] Failed to resume active saved scene:', e);
      }
    }

    // ── Resume the document this project was left on (plan-703 §2.6.3, F15) ──
    //
    // The `(asset, mode)` pair per project id has been written on every open
    // since plan-703 and, until now, read in exactly ONE situation: the effect
    // that fires when the user opens a project BY HAND (`pendingResumeRef` in
    // ProjectsDashboardHost). A reload does not open the project, it RESTORES
    // it — so that effect stays disarmed and the boot fell through to
    // `settings.json`'s `defaultModel`, i.e. the demo model, however far away
    // the user had actually navigated.
    //
    // Since plan-716 Phase 3 a document DOES have an address — `openDocument`
    // writes `?doc=<id>` — so the URL now carries the common case and this block
    // is the second line of defence, not the only one: a reload with a cleared
    // address bar, a fresh tab, a crash before the first `replaceState`, or the
    // `updateUrl: false` boot. It stays because the URL is a statement about ONE
    // load, and the remembered pair is a statement about the SESSION.
    //
    // Precedence is `resolveResumeTarget`'s, not this file's, and this block
    // sits BELOW the URL routing and the active-scene pointer because both are
    // more specific statements about this particular load. Only the
    // `remembered` source is acted on here: `url` was routed above and
    // `defaultModel` is the fallback the block below already owns.
    if (!sceneRouted) {
      try {
        const project = getProjectStore().getProject();
        const projectId = project?.id;
        if (projectId) {
          const modeLocked = viewer.modes.lockedMode !== null;
          const target = resolveResumeTarget({
            search: window.location.search,
            remembered: readRememberedSession(projectId),
            // Inert on the unlocked path — this block acts on `remembered`
            // only, so a `projectActive` answer changes nothing here and falls
            // through to the legacy block exactly as a `defaultModel` answer
            // already did. It is passed because it is the kiosk's SECOND stage
            // (plan-721 §2.4), and the appliance boot below does act on it.
            projectActive: project?.activeSceneId ?? null,
            // plan-721 §2.4, and the same rule in ProjectsDashboardHost: the
            // PROJECT's own start document beats the global one. On the
            // appliance there IS no global one — its `project.json` is the
            // boot SSOT — and in every other delivered build the two hold the
            // same value, because `bareDefaultModel()` derives the global one
            // from the manifest.
            defaultModel: projectStartDocument(project) ?? appConfig.defaultModel,
            // A kiosk ignores the URL and the remembered pair (decision 3): a
            // locked deployment must come up in its machine, not in whatever
            // somebody last looked at on that tablet.
            modeLocked,
          });

          // ── The appliance boot (plan-721 §2.4, F1/F8) ─────────────────
          //
          // A kiosk pointed at a served project (`?projectUrl=`) opens the
          // document its manifest names — so unlike the unlocked path it acts
          // on `defaultModel`/`projectActive` too, and never reaches the
          // legacy `entries[0]` resolution below. That legacy block belongs to
          // the OTHER deployments and is deliberately not deleted; it simply
          // must be unreachable from here.
          //
          // Everything that can go wrong here used to be silent: a 404, a 500
          // and a corrupt project.json were swallowed identically by the
          // backend, which then answered with a synthetic demo manifest.
          // plan-735 removed that fallback and made the backend log which of
          // them happened — but a console line is not an answer on a panel with
          // no keyboard, so the verdict below still turns each cause into a
          // visible
          // card instead (F8).
          if (modeLocked && servedProjectUrl) {
            const documents = documentsOf(project);
            const doc = findStartDocument(documents, target.asset) ?? undefined;
            const verdict = diagnoseKioskBoot({
              projectUrl: servedProjectUrl,
              hasDeployedManifest: servedProjectManifestOk,
              documentCount: documents.length,
              resolvedAsset: target.asset,
              assetExists: !!doc,
            });
            if (!verdict.ok) {
              console.error(`[main] Appliance boot failed (${verdict.reason}): ${verdict.detail}`);
              showLoadingError(
                `${verdict.detail}\n\nChecked at ${new Date().toISOString()}.`,
              );
              // Routed on purpose, though nothing loaded: the card IS the
              // answer, and falling through to the legacy block would replace
              // it with a catalogue model — a wrong machine shown as if it
              // were the right one.
              sceneRouted = true;
            } else if (doc) {
              await sceneStore.openDocument(doc.id, { name: doc.name });
              hideLoadingOverlay();
              sceneRouted = true;
            }
          } else if (target.source === 'remembered' && target.asset) {
            // Addressed by path or by id: a stored pair may hold either, and
            // refusing one of the two would make the rule depend on which
            // spelling happened to be written. `findStartDocument` is that rule
            // (plan-726 F12), shared with the kiosk branch above, the
            // `defaultModel` branch below and the dashboard's resume effect.
            const doc = findStartDocument(project, target.asset);
            if (!doc) {
              // Renamed, deleted or from another project's manifest. Drop the
              // hint rather than re-resolving a dead path on every reload.
              forgetRememberedSession(projectId);
            } else if (!await guardHeavyRestore(doc.id, doc.name)) {
              // The same heavy-CAD escape hatch the other two restore paths use,
              // and for the same reason: an auto-restore must not be the thing
              // that makes a phone run out of memory on every visit. Declining
              // also forgets the pair — otherwise the dialog would come back on
              // every single reload, which is the opposite of an escape hatch.
              forgetRememberedSession(projectId);
            } else {
              // THE open verb (plan-716 §2.5), for both sections — a scene and a
              // model are the same thing since plan-413, and `openDocument` is
              // where that stopped being a claim. It also supplies the two
              // things this block used to hand-roll: `?doc=<id>` in the address
              // bar, so the NEXT reload does not need the remembered pair at
              // all, and the cross-mode document identity the asset editor reads
              // to decide what to bind to when the restored mode takes over.
              await sceneStore.openDocument(doc.id, { name: doc.name });
              hideLoadingOverlay();
              sceneRouted = true;
            }
            // The mode comes from the remembered pair only — `resolveResumeTarget`
            // guarantees a URL and a `defaultModel` both return `mode: null`.
            if (sceneRouted && target.mode) resumeBootMode = target.mode;
          } else if (target.source === 'defaultModel' && target.asset) {
            // ── The project's start document (plan-726 F2) ────────────────
            //
            // The gap this closes: `resolveResumeTarget()` has been answering
            // `source: 'defaultModel'` on the unlocked boot all along, and this
            // block simply dropped that answer on the floor. The boot then fell
            // through to the legacy catalogue resolution below, which re-derives
            // the same GLB from `settings.json` and opens it as a bare BUILT-IN
            // — so the visitor got the model but never the project it belongs
            // to, and `?doc=` was never written.
            //
            // It lives HERE, in the half that has `project`, and not in the
            // legacy block below: down there `project` is out of scope, the
            // resolution is URL-shaped rather than document-shaped, and putting
            // it there would reproduce exactly the bug this branch removes.
            //
            // `defaultModel` reaches this point already merged — the PROJECT's
            // own `settings.defaultModel` first, the global `settings.json` one
            // second (see the `defaultModel:` argument above) — so an appliance,
            // a customer deploy and the public demo all arrive here with the
            // right string and differ only in where it came from.
            //
            // A miss is deliberately NOT an error: the string may name a model
            // that exists in the deploy but not in `documents[]` (every build
            // before this plan), and the legacy block below resolves exactly
            // that case. `sceneRouted` stays false and the fall-through happens.
            const doc = findStartDocument(project, target.asset);
            if (doc && await guardHeavyRestore(doc.id, doc.name)) {
              // `openDocument`, not `openBuiltin`: it is what makes the demo a
              // PROJECT rather than a GLB with a project-shaped wrapper — the
              // `?doc=<id>` address, the document identity the asset editor
              // binds to, and the resume pair for the next reload all come from
              // this one verb. The `model-loaded` event (and with it the
              // `model_view` GA funnel) is raised by the viewer's own load,
              // which both verbs go through, so the funnel is unchanged.
              await sceneStore.openDocument(doc.id, { name: doc.name });
              hideLoadingOverlay();
              sceneRouted = true;
            }
          }
        }
      } catch (e) {
        console.warn('[main] Failed to resume the last document:', e);
      }
    }

    if (sceneRouted) {
      // ?scene=… or active id already loaded — skip legacy model resolution.
    } else {
      // Default-model boot. Route through sceneStore.openBuiltin(...) so the
      // per-base draft (rv-scenes/draft/<base>) is consulted on every reload —
      // not just for explicit `?scene=builtin:` URLs. This restores
      // property-inspector edits (setField ops) which the legacy loadModel()
      // path discards via markGlbActive's empty-baseline workspace.
      const finalUrl = modelToLoad ?? entries[0]?.url ?? null;
      if (finalUrl) {
        const matched = entries.find(e => e.url === finalUrl);
        const label = matched
          ? matched.filename.replace(/\.glb$/i, '')
          : (finalUrl.split('/').pop() ?? finalUrl).split('?')[0].replace(/\.glb$/i, '');
        try {
          // updateUrl:false — the visitor arrived without an explicit scene
          // route, so the address bar stays exactly as typed. A bare `/` must
          // NOT be rewritten to `?scene=builtin:<default>.glb` (project-based
          // routing: `/` is the canonical entry). Reload re-resolves the same
          // default via localStorage/settings.json anyway.
          await sceneStore.openBuiltin(finalUrl, label, { updateUrl: false });
          hideLoadingOverlay();
        } catch (e) {
          // Defence-in-depth: corrupted draft or transient error → fall back
          // to the legacy boot so the page still loads.
          console.warn('[main] sceneStore.openBuiltin failed, falling back to loadModel:', e);
          loadModel(finalUrl);
        }
      } else {
        // ── Nothing resolved, and it is no longer silent (plan-735 F7/3d) ──
        //
        // This branch used to hide the overlay and stop. That was defensible
        // while `readManifest()` could not fail: the deploy always had a
        // project and reaching here meant the visitor had simply not asked for
        // anything. Since plan-735 it is reachable for four reasons that are
        // all deploy FAULTS, and all of them looked identical — a blank
        // viewport with a working UI:
        //
        //  1. no `project.json` at the deploy root (404 / CORS / `file://`);
        //  2. a `project.json` that is not a valid v2 manifest;
        //  3. a valid manifest with `documents: []`;
        //  4. a manifest whose every row was `devOnly` and got pruned.
        //
        // The distinction the visitor needs is not WHICH of the four, but that
        // it is the deploy and not their click. The console line carries the
        // detail; the card carries the sentence. `hasDeployedManifest()` is
        // what separates "no project served" from "project served but empty",
        // the same split `diagnoseKioskBoot()` makes for the appliance (F8) —
        // this is that guarantee generalised off the `?projectUrl=` path.
        const project = getProjectStore().getProject();
        const documentCount = documentsOf(project).length;
        const served = getProjectStore().getBundledBackend().hasDeployedManifest();
        const detail = !served
          ? 'This deploy root serves no project.json, so there is nothing to open. '
            + 'The file may be missing, blocked by CORS, or unreachable from this origin.'
          : documentCount === 0
            ? 'The project served by this deploy root declares no documents.'
            : 'The project served by this deploy root declares no document that this build can open.';
        console.error(`[main] Nothing to open (documents: ${documentCount}, manifest served: ${served}): ${detail}`);
        showLoadingError(detail);
      }
    }
  }

  // Workspace mode boot (plan-198). Precedence: ?mode= URL param (if a
  // registered mode) > opened published example's catalogue mode > the resumed
  // project session's mode > persisted localStorage > 'hmi'. Applied AFTER the
  // model/scene has loaded so mode plugins
  // (e.g. Planner) see live model state in their onModeActivate hook. The legacy
  // ?mode=planner empty-scene routing above is unchanged; entering Planner mode
  // now runs through the mode system.
  if (!connectEmbedEnabled) {
    const urlMode = params.get('mode');
    if (urlMode && viewer.modes.has(urlMode)) {
      viewer.modes.setMode(urlMode);
    } else if (publishedBootMode && viewer.modes.has(publishedBootMode)) {
      viewer.modes.setMode(publishedBootMode);
    } else if (resumeBootMode && viewer.modes.has(resumeBootMode)) {
      // The resumed session's own mode (decision 24). Above `restore()` because
      // that answer is global, and the pair is per project — but below the two
      // above, which are statements about THIS load.
      viewer.modes.setMode(resumeBootMode);
    } else {
      viewer.modes.restore('hmi');
    }
  }

  // --- Initialize HMI React Overlay ---
  initHMI(viewer);

  // --- Dev-only: test runner + debug endpoint ---
  if (import.meta.env.DEV) {
    initTestRunner();
    const { DebugEndpointPlugin } = await import('./plugins/debug-endpoint-plugin');
    viewer.use(new DebugEndpointPlugin(), 'core');

    // --- Dev-only: expose the viewer for Playwright E2E + manual QA ---
    (window as unknown as { __rvViewer?: unknown }).__rvViewer = viewer;

    // --- Dev-only: expose window.__rvInstruction for Playwright E2E + manual QA ---
    const instrStore = await import('./core/hmi/instruction-store');
    (window as unknown as { __rvInstruction?: unknown }).__rvInstruction = {
      show: instrStore.showInstruction,
      hide: instrStore.hideInstruction,
      clearBySource: instrStore.clearBySource,
      list: instrStore.getInstructions,
    };

    // --- Dev-only: MU compute-transform spike benchmark (plan-271 Phase 4) ---
    // window.__rvMuComputeBench(counts?, frames?) — driven by
    // scripts/mu-compute-bench.mjs (headed Chromium, real GPU).
    const { installMuComputeBench } = await import('./core/engine/rv-mu-compute-bench');
    installMuComputeBench(viewer);
  }

  // --- MCP bridge (AI integration) ---
  // Always registered so the Settings -> AI tab is available everywhere,
  // including the public demo. The bridge does NOT auto-connect: it stays
  // disabled until the user enables it in the AI tab (loadSettings defaults
  // enabled=false), so a normal page load makes no localhost connection
  // attempts. DEV / ?mcp=1 are no longer required just to see the tab.
  {
    const { McpBridgePlugin } = await import('./plugins/mcp-bridge-plugin');
    viewer.use(new McpBridgePlugin(), 'core');
  }

  // Reopen the panels that were open before the reload (CONNECT, hierarchy, …).
  // The manager has persisted open/close all along — this is the boot-time
  // counterpart that actually restores them (saved widths ride in the payload).
  if (connectEmbedEnabled) {
    viewer.leftPanelManager.open('connect', getStoredConnectPanelWidth());
  } else {
    viewer.leftPanelManager.restore();
  }
}

init().catch(console.error);
