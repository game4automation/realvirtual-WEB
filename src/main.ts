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

import { RVViewer } from './core/rv-viewer';
import { debug, logInfo } from './core/engine/rv-debug';
import { initTestRunner } from './rv-test-runner';
import { fetchAppConfig, setAppConfig, initAnalytics } from './core/rv-app-config';
import { loadVisualSettings } from './core/hmi/visual-settings-store';
import { isMobileDevice } from './hooks/use-mobile-layout';
import { activateContext, registerUIElement } from './core/hmi/ui-context-store';

// Private content (resolves to stubs when private folder is absent)
import { initHMI } from '@rv-private/custom/hmi-entry';
import { registerPrivatePlugins } from '@rv-private/private-plugins';

// Hide AGPL watermark for commercial/private builds
// (private projects show "powered by realvirtual" in the logo badge instead)
if (__RV_COMMERCIAL__ || __RV_HAS_PRIVATE__) {
  const wm = document.getElementById('rv-watermark');
  if (wm) wm.style.display = 'none';
}

// Core Plugins (always included in public AGPL build)
import { SensorMonitorPlugin } from './plugins/sensor-monitor-plugin';
import { TransportStatsPlugin } from './plugins/transport-stats-plugin';
import { CameraEventsPlugin } from './plugins/camera-events-plugin';
import { DriveOrderPlugin } from './plugins/drive-order-plugin';
import { CameraStartPosPlugin } from './plugins/camera-startpos-plugin';
import { WebSensorPlugin } from './plugins/web-sensor-plugin';
import { RapierPhysicsPlugin } from './core/engine/rapier-physics-plugin';
import { loadPhysicsSettings } from './core/hmi/physics-settings-store';

// Extras editor plugin (hierarchy browser + property editor)
import { RvExtrasEditorPlugin } from './core/hmi/rv-extras-editor';

// Industrial interface plugins (WebSocket Realtime, ctrlX, etc.)
import { InterfaceManager } from './interfaces/interface-manager';
import { WebSocketRealtimeInterface } from './interfaces/websocket-realtime-interface';
import { CtrlXInterface } from './interfaces/ctrlx-interface';

// Per-model plugin manager (loads/unloads plugins on model switch)
import { ModelPluginManager } from './core/rv-model-plugin-manager';

// Microsoft Teams JS SDK — dynamically imported only when ?teams=1

// --- localStorage keys ---
const LS_KEY_MODEL = 'rv-webviewer-last-model';
const LS_KEY_RENDERER = 'rv-webviewer-renderer';

// --- Renderer selection via URL parameter (fallback to localStorage) ---
// Mobile/touch devices always use WebGL — WebGPU is desktop-only unless explicitly overridden.
const params = new URLSearchParams(window.location.search);
const isTouchDevice = isMobileDevice();
const useWebGPU = !isTouchDevice
  && (params.get('renderer') ?? localStorage.getItem(LS_KEY_RENDERER)) === 'webgpu';

// --- Loading overlay ---
const loadingOverlay = document.getElementById('loading-overlay')!;
const loadingModelName = document.getElementById('loading-model-name')!;
const loadingProgressBar = document.getElementById('loading-progress-bar')!;
const loadingProgressPct = document.getElementById('loading-progress-pct')!;

function showLoadingOverlay(modelName: string) {
  loadingModelName.textContent = modelName;
  loadingProgressBar.classList.add('indeterminate');
  loadingProgressBar.style.width = '';
  loadingProgressPct.textContent = '';
  loadingOverlay.classList.remove('fade-out', 'hidden');
}

function setLoadingProgress(loaded: number, total: number) {
  const pct = Math.round((loaded / total) * 100);
  loadingProgressBar.classList.remove('indeterminate');
  loadingProgressBar.style.width = `${pct}%`;
  const loadedMB = (loaded / (1024 * 1024)).toFixed(1);
  const totalMB = (total / (1024 * 1024)).toFixed(1);
  loadingProgressPct.textContent = `${loadedMB} / ${totalMB} MB`;
}

function hideLoadingOverlay() {
  loadingOverlay.classList.add('fade-out');
  setTimeout(() => {
    loadingOverlay.classList.add('hidden');
    loadingOverlay.classList.remove('fade-out');
  }, 600);
}

async function init() {
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

  // --- Analytics (only when configured in settings.json) ---
  initAnalytics();

  // --- Bootstrap context-aware UI visibility (from settings.json `ui` key) ---
  {
    const uiCfg = appConfig.ui;
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

  const container = document.getElementById('app')!;

  // --- Resolve antialias BEFORE renderer creation (constructor-only param) ---
  const initialSettings = loadVisualSettings();
  const wantAntialias = initialSettings.antialias !== false && !isTouchDevice;

  // --- Create Viewer ---
  const viewer = await RVViewer.create(container, { useWebGPU, antialias: wantAntialias });

  // Apply persisted DPR cap (runtime-changeable, no reload needed)
  viewer.maxDpr = initialSettings.maxDpr;

  // Expose viewer globally for console debugging
  (window as unknown as { viewer: RVViewer }).viewer = viewer;

  // --- Preload Rapier WASM (non-blocking) ---
  // Start WASM download in background. If it finishes before model load,
  // physics will be used; otherwise kinematic transport kicks in and
  // physics activates on the next model load.
  const rapierPlugin = new RapierPhysicsPlugin(loadPhysicsSettings);
  const rapierReady = rapierPlugin.preload();

  // --- Register Industrial Interfaces ---
  const ifaceManager = new InterfaceManager();
  ifaceManager.register(new WebSocketRealtimeInterface());
  ifaceManager.register(new CtrlXInterface());

  // --- Register Core Plugins ---
  viewer
    .use(ifaceManager)
    .use(rapierPlugin)
    .use(new DriveOrderPlugin())
    .use(new SensorMonitorPlugin())
    .use(new TransportStatsPlugin())
    .use(new CameraEventsPlugin())
    .use(new CameraStartPosPlugin())
    .use(new WebSensorPlugin())
    .use(new RvExtrasEditorPlugin());

  // --- Per-model plugin manager (loads model-specific plugins on model switch) ---
  viewer.modelPluginManager = new ModelPluginManager();

  // --- Performance test plugin (activated via ?perf URL param) ---
  if (params.has('perf')) {
    const { PerfTestPlugin } = await import('./plugins/demo/perf-test-plugin');
    viewer.use(new PerfTestPlugin());
  }

  // --- Register Private Plugins (no-op in public build) ---
  registerPrivatePlugins(viewer);

  // --- Model discovery ---
  const modelFiles = import.meta.glob('/public/models/*.glb', { query: '?url', import: 'default', eager: true }) as Record<string, string>;
  const entries = Object.keys(modelFiles).map((key) => {
    const filename = key.split('/').pop()!;
    return { filename, url: `${import.meta.env.BASE_URL}models/${filename}` };
  });

  // Discover private project models (served by privateModelsPlugin in dev)
  try {
    const resp = await fetch('/__api/private-models');
    if (resp.ok) {
      const privateModels: Array<{ project: string; filename: string; url: string }> = await resp.json();
      for (const pm of privateModels) {
        entries.push({ filename: pm.filename, url: pm.url });
      }
    }
  } catch { /* private models endpoint not available (production build) — ignore */ }

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

  // Expose discovered models to the HMI model selector
  viewer.availableModels = entries.map((e) => ({ url: e.url, label: e.filename.replace(/\.glb$/i, '') }));

  // --- Load model helper ---
  async function loadModel(url: string) {
    const modelName = (url.split('/').pop() ?? url).split('?')[0].replace(/\.glb$/i, '');
    showLoadingOverlay(modelName);
    localStorage.setItem(LS_KEY_MODEL, url);

    try {
      const loadStart = performance.now();

      // Fetch with streaming progress
      const resp = await fetch(url);
      const contentLength = resp.headers.get('content-length');
      const totalBytes = contentLength ? parseInt(contentLength) : 0;
      const sizeMB = totalBytes ? (totalBytes / (1024 * 1024)).toFixed(1) + ' MB' : '--';

      let modelUrl = url;
      if (totalBytes && resp.body) {
        // Stream the response to track download progress
        const reader = resp.body.getReader();
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          loaded += value.byteLength;
          setLoadingProgress(loaded, totalBytes);
        }
        const blob = new Blob(chunks as BlobPart[]);
        modelUrl = URL.createObjectURL(blob);
      }

      // Store original URL before loadModel (loadModel will set _currentModelUrl to blob URL)
      viewer.pendingModelUrl = url;

      const result = await viewer.loadModel(modelUrl);

      // Restore original URL (not blob:) so model selector can match it
      viewer.currentModelUrl = url;

      // Clean up blob URL after a delay — GLTFLoader may have pending async
      // operations (DRACO decoder, texture loading) that still reference the
      // blob URL after loadModel() resolves.
      if (modelUrl !== url) setTimeout(() => URL.revokeObjectURL(modelUrl), 5000);

      const loadTime = ((performance.now() - loadStart) / 1000).toFixed(1) + 's';
      viewer.lastLoadInfo = { glbSize: sizeMB, loadTime };
      logInfo(`Model loaded: ${sizeMB}, ${loadTime}, ${result.drives.length} drives`);
      hideLoadingOverlay();
    } catch (e) {
      console.error(`[main] Failed to load model: ${url}`, e);
      hideLoadingOverlay();
    }
  }

  // Expose loadModel with progress overlay so Settings > Model can use it
  viewer.loadModelWithProgress = loadModel;

  // --- Firebase demo mode: /demo/webviewer/{demoName} ---
  const pathParts = window.location.pathname.split('/').filter(p => p);
  const webviewerIdx = pathParts.indexOf('webviewer');
  const firebaseDemoName = webviewerIdx >= 0 && pathParts[webviewerIdx + 1] ? pathParts[webviewerIdx + 1] : null;

  if (firebaseDemoName) {
    const bucketName = 'realvirtual-files.firebasestorage.app';
    const storagePath = `demo/webviewer/${firebaseDemoName}/demo.glb`;
    const firebaseGlbUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media`;
    debug('config', `Firebase demo: "${firebaseDemoName}" → ${firebaseGlbUrl}`);
    document.title = `${firebaseDemoName} - realvirtual WEB`;
    loadModel(firebaseGlbUrl);
  } else {
    // Model priority: URL param > last opened (localStorage, if still available) > settings.json defaultModel > first model.
    // The user's last choice wins over the deployer's default — `defaultModel` only kicks in on first visit
    // (empty localStorage) or when the saved model no longer exists in the manifest (e.g. after a deploy removed it).
    const urlModel = params.get('model');
    const configModel = appConfig.defaultModel;
    const savedModel = localStorage.getItem(LS_KEY_MODEL);

    // Resolve configModel: match against discovered entries, or build a URL from filename/path
    let resolvedConfigModel: string | null = null;
    if (configModel) {
      const match = entries.find((e) => e.url === configModel || e.filename === configModel);
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

    const modelToLoad = urlModel
      ?? savedEntry?.url
      ?? resolvedConfigModel
      ?? null;

    if (modelToLoad) {
      loadModel(modelToLoad);
    } else {
      // Default to first available model
      const defaultEntry = entries[0];
      if (defaultEntry) {
        loadModel(defaultEntry.url);
      } else {
        hideLoadingOverlay();
      }
    }
  }

  // --- Wait for Rapier WASM (non-critical, already has internal fallback) ---
  await rapierReady;

  // --- Initialize HMI React Overlay ---
  initHMI(viewer);

  // --- Dev-only: test runner + debug endpoint ---
  if (import.meta.env.DEV) {
    initTestRunner();
    const { DebugEndpointPlugin } = await import('./plugins/debug-endpoint-plugin');
    viewer.use(new DebugEndpointPlugin());
  }

  // --- MCP bridge: DEV mode or ?mcp=1 URL param ---
  if (import.meta.env.DEV || params.has('mcp')) {
    const { McpBridgePlugin } = await import('./plugins/mcp-bridge-plugin');
    viewer.use(new McpBridgePlugin());
  }
}

init().catch(console.error);
