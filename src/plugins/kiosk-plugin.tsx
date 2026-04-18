// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * KioskPlugin — Core plugin for Kiosk Mode (auto-demo after idle).
 *
 * Responsibilities:
 *  - Idle detection (IdleDetector) — auto-starts tour after N seconds
 *  - Tour orchestration (TourRunner) — runs registered TourFn async functions
 *  - Context-conflict guard — refuses to start while FPV / Maintenance active
 *  - WelcomeModal awareness — pauses idle while modal open
 *  - UI surfaces — DemoButton (button-group), KioskChrome (overlay) including
 *    always-clickable ExitChip, TouchHint, AriaLive, and chart overlays
 *  - Public API — registerTour(modelName, tourFn) / unregisterTour(modelName)
 *
 * Tours are authored as plain async functions (`TourFn`). The optional
 * declarative `TourDefinition` JSON schema is NOT yet internally converted
 * in this v1 implementation (see roadmap / follow-up).
 *
 * Zero breaking changes: this plugin is purely additive. Default is disabled
 * (`enabled: false` in settings) — opt-in only.
 */

import {
  memo,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  Box,
  Button,
  Chip,
  IconButton,
  Tooltip,
} from '@mui/material';
import SlideshowOutlinedIcon from '@mui/icons-material/SlideshowOutlined';
import CloseIcon from '@mui/icons-material/Close';
import TouchAppIcon from '@mui/icons-material/TouchApp';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVViewer } from '../core/rv-viewer';
import {
  activateContext,
  deactivateContext,
  isContextActive,
} from '../core/hmi/ui-context-store';
import {
  showInstruction,
  clearBySource,
} from '../core/hmi/instruction-store';
import { subscribeWelcomeModal, isWelcomeModalOpen } from '../core/hmi/welcome-modal-store';
import {
  DEFAULT_KIOSK_CONFIG,
  normalizeKioskConfig,
  applyUrlOverrides,
  prefersReducedMotion,
  type KioskConfig,
} from './kiosk-config';
import type { TourFn, TourApi, ChartKind } from './kiosk-tour-types';
import { createTourApi, makeKioskOpenState, type KioskOpenState } from './kiosk-tour-api';
import { IdleDetector } from './kiosk-idle-detector';
import { OeeChart } from './demo/OeeChart';
import { PartsChart } from './demo/PartsChart';
import { CycleTimeChart } from './demo/CycleTimeChart';
import { EnergyChart } from './demo/EnergyChart';

// ─── Chart state store (module-level pub/sub) ───────────────────────────

const _openCharts: Set<ChartKind> = new Set();
const _chartListeners = new Set<() => void>();
let _chartSnapshot: ReadonlySet<ChartKind> = new Set();

function _notifyCharts(): void {
  _chartSnapshot = new Set(_openCharts);
  for (const l of _chartListeners) { try { l(); } catch (e) { console.error(e); } }
}
function _openChart(kind: ChartKind): void {
  if (_openCharts.has(kind)) return;
  _openCharts.add(kind);
  _notifyCharts();
}
function _closeChart(kind: ChartKind): void {
  if (!_openCharts.has(kind)) return;
  _openCharts.delete(kind);
  _notifyCharts();
}
function _closeAllCharts(): void {
  if (_openCharts.size === 0) return;
  _openCharts.clear();
  _notifyCharts();
}

// ─── Kiosk plugin state store (for DemoButton + KioskChrome reactive UI) ──

interface KioskSnapshot {
  /** True if ANY tour is registered (may be for a model not yet loaded) — used
   *  by WelcomeModal to decide whether to show "Start Demo" button. */
  hasTour: boolean;
  /** True if a tour is registered for the CURRENTLY loaded model. */
  hasCurrentModelTour: boolean;
  isActive: boolean;
  tourName: string | null;
}

// Single active plugin instance (plugin registered once via viewer.use())
let _pluginInstance: KioskPlugin | null = null;

// Stable pub/sub wrapper so hooks work even if plugin instance is set LATER
// (e.g. WelcomeModal mounts before main.ts's viewer.use(new KioskPlugin()) runs).
const _globalListeners = new Set<() => void>();
function _globalSubscribe(listener: () => void): () => void {
  _globalListeners.add(listener);
  const innerUnsub = _pluginInstance?.subscribe(listener);
  return () => {
    _globalListeners.delete(listener);
    innerUnsub?.();
  };
}
function _notifyGlobalListeners(): void {
  for (const l of _globalListeners) { try { l(); } catch (e) { console.error(e); } }
}
function _registerPluginInstance(p: KioskPlugin | null): void {
  _pluginInstance = p;
  _notifyGlobalListeners();
}

// ─── KioskPlugin class ──────────────────────────────────────────────────

export class KioskPlugin implements RVViewerPlugin {
  readonly id = 'kiosk';
  readonly order = 250;   // after DriveOrder(0), Physics(~100), Maintenance(200), MachineControl(210)
  readonly core = true;   // plugin persists across model loads

  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: DemoButton, order: 55 },
    { slot: 'overlay', component: KioskChrome, order: 100 },
  ];

  private _viewer: RVViewer | null = null;
  private _config: KioskConfig = DEFAULT_KIOSK_CONFIG;
  private _registeredTours = new Map<string, TourFn>();
  private _currentModelName: string | null = null;
  private _tourRunner: TourRunner | null = null;
  private _idleDetector: IdleDetector | null = null;
  private _welcomeModalUnsub: (() => void) | null = null;
  private _cycleCount = 0;
  private _listeners = new Set<() => void>();
  private _snapshot: KioskSnapshot = { hasTour: false, hasCurrentModelTour: false, isActive: false, tourName: null };
  private _exitKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private _exitPointerHandler: ((e: PointerEvent) => void) | null = null;
  private _kioskExitListener: (() => void) | null = null;
  /** Set when WelcomeModal's "Start Demo" is clicked before model is loaded. */
  private _pendingStart = false;

  // ─── Lifecycle ────────────────────────────────────────────────────

  constructor(configOverride?: Partial<KioskConfig>) {
    _registerPluginInstance(this);
    if (configOverride) {
      this._config = normalizeKioskConfig({ ...DEFAULT_KIOSK_CONFIG, ...configOverride });
    }
  }

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;
    // Model name = GLB filename without extension (read from viewer, not LoadResult)
    this._currentModelName = deriveModelNameFromUrl(viewer.currentModelUrl);
    this._cycleCount = 0;

    // Stop any prior tour before reconfiguring
    if (this._tourRunner?.isRunning) {
      this._tourRunner.stop();
      this._tourRunner = null;
    }

    // Apply URL overrides on top of normalized config
    try {
      const params = new URLSearchParams(window.location.search);
      this._config = applyUrlOverrides(this._config, params);
    } catch { /* URL parse error — keep config */ }

    // Subscribe to welcome-modal-store for idle-pause behavior
    this._welcomeModalUnsub?.();
    this._welcomeModalUnsub = subscribeWelcomeModal(() => this._onWelcomeModalChanged());

    // Listen for explicit exit requests (e.g., from t.message action)
    this._kioskExitListener?.();
    this._kioskExitListener = viewer.on('kiosk-exit-requested' as string, () => this.stopKiosk());

    // Start idle detector if enabled and tour registered for this model
    if (this._config.enabled && this._resolveCurrentTour()) {
      this._startIdleDetector();

      // ?kiosk=now → start immediately
      if (this._config.idleTimeoutSeconds === 0) {
        // Defer one microtask to let onModelLoaded finish
        queueMicrotask(() => this.startKiosk());
      }
    }

    // Honour a pending-start (WelcomeModal "Start Demo" clicked before model-load)
    if (this._pendingStart && this._resolveCurrentTour()) {
      this._pendingStart = false;
      queueMicrotask(() => this._doStartKiosk());
    }

    this._notify();
  }

  onModelCleared(): void {
    // Stop tour immediately; onModelLoaded will reconfigure for the next model
    if (this._tourRunner?.isRunning) {
      this._tourRunner.stop();
      this._tourRunner = null;
    }
    this._idleDetector?.stop();
    this._idleDetector = null;
    deactivateContext('kiosk');
    _closeAllCharts();
    clearBySource('kiosk');
    this._viewer = null;
    this._currentModelName = null;
    this._notify();
  }

  dispose(): void {
    this.stopKiosk();
    this._idleDetector?.stop();
    this._idleDetector = null;
    this._welcomeModalUnsub?.();
    this._welcomeModalUnsub = null;
    this._kioskExitListener?.();
    this._kioskExitListener = null;
    this._removeExitInteractionListeners();
    this._registeredTours.clear();
    this._listeners.clear();
    this._viewer = null;
    if (_pluginInstance === this) _registerPluginInstance(null);
  }

  // ─── Public API ───────────────────────────────────────────────────

  /**
   * Register a TourFn for a model by GLB filename (without `.glb` extension).
   * If a tour is already registered for `modelName`, it is replaced.
   * @public @stable v1
   */
  registerTour(modelName: string, fn: TourFn): void {
    this._registeredTours.set(modelName, fn);
    // If this was the currently-loaded model and we were waiting for a tour, start idle
    if (this._viewer && this._currentModelName === modelName && this._config.enabled) {
      this._startIdleDetector();
    }
    // Honour a pending-start (WelcomeModal "Start Demo" clicked before tour registered)
    if (this._pendingStart && this._viewer && this._currentModelName === modelName) {
      this._pendingStart = false;
      queueMicrotask(() => this._doStartKiosk());
    }
    this._notify();
  }

  /** @public @stable v1 */
  unregisterTour(modelName: string): void {
    this._registeredTours.delete(modelName);
    // If this was the current model and tour is running, stop it
    if (this._currentModelName === modelName && this._tourRunner?.isRunning) {
      this.stopKiosk();
    }
    this._notify();
  }

  /**
   * Start the kiosk tour for the current model. Idempotent.
   * If no model is loaded yet OR no tour is registered for the current model
   * yet, sets `_pendingStart` flag so that the tour starts automatically as
   * soon as the model + tour become available. This enables the WelcomeModal
   * "Start Demo" button to work even when clicked BEFORE the GLB has loaded.
   *
   * @public @stable v1
   */
  startKiosk(): void {
    if (this._tourRunner?.isRunning) return;

    // Context-conflict guard — refuse if FPV or Maintenance active
    if (isContextActive('fpv') || isContextActive('maintenance')) {
      showInstruction({
        id: 'kiosk-conflict',
        text: 'Cannot start demo while in another mode',
        anchor: { kind: 'edge', edge: 'bottom' },
        style: 'warning',
        autoClearAfterMs: 3000,
        source: 'kiosk',
      });
      return;
    }

    // If the viewer / model / tour isn't ready yet (e.g. user clicked "Start Demo"
    // on the WelcomeModal before first GLB load finished), remember the intent
    // and start as soon as onModelLoaded + registerTour have both run.
    if (!this._viewer || !this._resolveCurrentTour()) {
      this._pendingStart = true;
      return;
    }

    this._doStartKiosk();
  }

  /** @internal — actually start the tour once all prerequisites are met. */
  private _doStartKiosk(): void {
    if (this._tourRunner?.isRunning) return;
    if (!this._viewer) return;

    const tourFn = this._resolveCurrentTour();
    if (!tourFn) {
      console.info('[kiosk] no tour registered for current model');
      return;
    }

    // Activate context BEFORE stopping idle (rollback-safe ordering)
    let contextActivated = false;
    try {
      activateContext('kiosk');
      contextActivated = true;
    } catch (err) {
      console.error('[kiosk] activateContext failed, aborting start:', err);
      return;
    }

    try {
      this._idleDetector?.stop();
      this._installExitInteractionListeners();
      this._tourRunner = new TourRunner(
        this._viewer,
        tourFn,
        this._config,
        () => { this._cycleCount++; },
      );
      void this._tourRunner.start();
      this._notify();
    } catch (err) {
      // Rollback on failure
      if (contextActivated) { try { deactivateContext('kiosk'); } catch { /* ignore */ } }
      this._removeExitInteractionListeners();
      if (this._config.enabled) this._idleDetector?.start();
      console.error('[kiosk] start failed:', err);
    }
  }

  /** Stop the kiosk tour. Idempotent. @public @stable v1 */
  stopKiosk(): void {
    // Clear any pending-start intent (e.g. user clicked "Start Demo" then pressed Exit)
    this._pendingStart = false;
    if (!this._tourRunner?.isRunning) {
      // Still cleanup residual state in case dispose came mid-stop
      _closeAllCharts();
      clearBySource('kiosk');
      return;
    }
    try { this._tourRunner.stop(); } catch (e) { console.error('[kiosk] stop failed:', e); }
    this._tourRunner = null;
    this._removeExitInteractionListeners();
    try { deactivateContext('kiosk'); } catch (e) { console.error(e); }
    _closeAllCharts();
    if (this._config.enabled && !isWelcomeModalOpen()) {
      this._idleDetector?.start();
    }
    this._notify();
  }

  /** @public @stable v1 */
  get isActive(): boolean { return this._tourRunner?.isRunning === true; }

  /** Pub/sub subscribe (for DemoButton). @internal */
  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  /** Pub/sub snapshot (for DemoButton). @internal */
  getSnapshot(): KioskSnapshot { return this._snapshot; }

  // ─── Private helpers ─────────────────────────────────────────────

  private _resolveCurrentTour(): TourFn | null {
    if (!this._currentModelName) return null;
    return this._registeredTours.get(this._currentModelName) ?? null;
  }

  private _startIdleDetector(): void {
    if (this._idleDetector) {
      this._idleDetector.updateTimeout(this._config.idleTimeoutSeconds * 1000);
      return;
    }
    this._idleDetector = new IdleDetector(
      this._config.idleTimeoutSeconds * 1000,
      () => this.startKiosk(),
    );
    this._idleDetector.start();
  }

  private _onWelcomeModalChanged(): void {
    const open = isWelcomeModalOpen();
    if (open) {
      this._idleDetector?.stop();
    } else if (this._config.enabled && !this.isActive) {
      this._idleDetector?.start();
    }
  }

  private _installExitInteractionListeners(): void {
    this._removeExitInteractionListeners();
    if (!this._config.exitOnAnyInput) return;
    this._exitPointerHandler = (e: PointerEvent): void => {
      // Ignore clicks on the ExitChip itself (we handle its onClick explicitly)
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-kiosk-exit-chip]')) return;
      this.stopKiosk();
    };
    this._exitKeydownHandler = (_e: KeyboardEvent): void => {
      this.stopKiosk();
    };
    window.addEventListener('pointerdown', this._exitPointerHandler, { capture: true });
    window.addEventListener('keydown', this._exitKeydownHandler, { capture: true });
  }

  private _removeExitInteractionListeners(): void {
    if (this._exitPointerHandler) {
      window.removeEventListener('pointerdown', this._exitPointerHandler, { capture: true });
      this._exitPointerHandler = null;
    }
    if (this._exitKeydownHandler) {
      window.removeEventListener('keydown', this._exitKeydownHandler, { capture: true });
      this._exitKeydownHandler = null;
    }
  }

  private _notify(): void {
    const currentTourFn = this._resolveCurrentTour();
    this._snapshot = {
      // ANY tour registered (for ANY model) — Welcome-modal button shows even before model-load
      hasTour: this._registeredTours.size > 0,
      // Tour for the CURRENTLY loaded model — used by DemoButton in toolbar
      hasCurrentModelTour: currentTourFn !== null,
      isActive: this.isActive,
      tourName: this._currentModelName,
    };
    for (const l of this._listeners) { try { l(); } catch (e) { console.error(e); } }
    // Also notify global subscribers (React hooks that subscribed before the
    // KioskPlugin instance existed — e.g. WelcomeModal mounted first).
    _notifyGlobalListeners();
  }
}

// ─── TourRunner (internal) ──────────────────────────────────────────────

class TourRunner {
  private readonly _abortController = new AbortController();
  private readonly _state: KioskOpenState;
  private _running = false;

  constructor(
    private readonly _viewer: RVViewer,
    private readonly _tourFn: TourFn,
    private readonly _config: KioskConfig,
    private readonly _onCycleEnd: () => void,
  ) {
    this._state = makeKioskOpenState();
  }

  get isRunning(): boolean { return this._running; }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    const api: TourApi = createTourApi(
      this._viewer,
      this._abortController.signal,
      this._config,
      this._state,
      _openChart,
      _closeChart,
      _setHierarchyFilter,
      this._onCycleEnd,
    );
    try {
      await this._tourFn(api, this._abortController.signal);
    } catch (err) {
      // AbortError is expected on stop(); anything else is a tour-function bug
      if ((err as Error | null)?.name !== 'AbortError') {
        console.error('[kiosk] tour function crashed:', err);
      }
    } finally {
      this._running = false;
      this._cleanup();
    }
  }

  stop(): void {
    if (!this._running) return;
    this._abortController.abort();
    this._viewer.cancelCameraAnimation?.();
    this._cleanup();
    this._running = false;
  }

  private _cleanup(): void {
    const safe = (fn: () => void, label: string): void => {
      try { fn(); } catch (e) { console.error(`[kiosk] cleanup '${label}' failed:`, e); }
    };
    safe(() => this._viewer.clearHighlight(), 'highlights');
    safe(() => clearBySource('kiosk'), 'instructions');
    if (this._state.pdfOpen) {
      safe(async () => { const m = await import('../core/hmi/pdf-viewer-store'); m.closePdfViewer(); }, 'pdf');
    }
    for (const panelId of this._state.openedPanels) {
      safe(() => this._viewer.leftPanelManager?.close(panelId), `panel:${panelId}`);
    }
    safe(() => _closeAllCharts(), 'charts');
    safe(() => this._viewer.selectionManager?.clear(), 'selection');
  }
}

// Hierarchy filter setter — placeholder that does nothing for v1
// (hierarchy-browser applies its own local filter state; a proper integration
// would require an additional store. For v1 the left-panel simply opens.)
function _setHierarchyFilter(_opts: { typeFilter?: string; searchTerm?: string }): void {
  // TODO v1.1: integrate with rv-hierarchy-browser filter state
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Derive a short model name (filename without `.glb`) from the URL that the
 * viewer last loaded. Returns null if no model is loaded. This is the key
 * used by `registerTour(modelName, fn)` so tours can be looked up by filename.
 */
function deriveModelNameFromUrl(url: string | null): string | null {
  if (!url) return null;
  // Strip query string, get filename, strip .glb extension
  const withoutQuery = url.split('?')[0] ?? url;
  const filename = withoutQuery.split('/').pop() ?? withoutQuery;
  return filename.replace(/\.glb$/i, '');
}

// ─── UI: DemoButton (left toolbar) ──────────────────────────────────────

function DemoButton(_props: UISlotProps): ReactNode {
  const snap = useSyncExternalStore(
    _globalSubscribe,
    () => _pluginInstance?.getSnapshot() ?? { hasTour: false, hasCurrentModelTour: false, isActive: false, tourName: null },
  );
  // Toolbar demo button: only for the currently loaded model's tour
  if (!snap.hasCurrentModelTour) return null;
  return (
    <Tooltip title={snap.isActive ? 'Stop demo' : 'Start demo'}>
      <IconButton
        data-testid="demo-button"
        aria-label={snap.isActive ? 'Stop demo' : 'Start demo'}
        size="small"
        color={snap.isActive ? 'primary' : 'default'}
        onClick={() => (snap.isActive ? _pluginInstance?.stopKiosk() : _pluginInstance?.startKiosk())}
      >
        <SlideshowOutlinedIcon />
      </IconButton>
    </Tooltip>
  );
}

// ─── UI: KioskChrome (overlay — exit chip + touch hint + aria-live + charts) ──

const KioskChrome = memo(function KioskChrome(_props: UISlotProps): ReactNode {
  const snap = useSyncExternalStore(
    _globalSubscribe,
    () => _pluginInstance?.getSnapshot() ?? { hasTour: false, hasCurrentModelTour: false, isActive: false, tourName: null },
  );
  const openCharts = useSyncExternalStore(
    (cb) => { _chartListeners.add(cb); return () => { _chartListeners.delete(cb); }; },
    () => _chartSnapshot,
  );
  const [hintVisible, setHintVisible] = useState(false);
  const reducedMotion = prefersReducedMotion();

  // Pulse hint every 15s while kiosk active
  useEffect(() => {
    if (!snap.isActive) { setHintVisible(false); return; }
    let mounted = true;
    const show = (): void => {
      if (!mounted) return;
      setHintVisible(true);
      setTimeout(() => { if (mounted) setHintVisible(false); }, 3000);
    };
    show();
    const interval = setInterval(show, 15000);
    return () => { mounted = false; clearInterval(interval); };
  }, [snap.isActive]);

  return (
    <>
      {/* Charts — always render (components handle their own open/close animation) */}
      <OeeChart open={openCharts.has('oee')} onClose={() => _closeChart('oee')} />
      <PartsChart open={openCharts.has('parts')} onClose={() => _closeChart('parts')} />
      <CycleTimeChart open={openCharts.has('cycleTime')} onClose={() => _closeChart('cycleTime')} />
      <EnergyChart open={openCharts.has('energy')} onClose={() => _closeChart('energy')} />

      {/* Kiosk-mode chrome: only when active */}
      {snap.isActive && (
        <>
          {/* ARIA live region for screen readers */}
          <Box
            role="status"
            aria-live="polite"
            sx={{ position: 'fixed', clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)', width: '1px', height: '1px', overflow: 'hidden' }}
          >
            Demo mode active
          </Box>

          {/* Exit chip — always clickable (zIndex 9999 > InstructionLayer 8600 > PDF 9000) */}
          <Chip
            data-kiosk-exit-chip
            data-testid="kiosk-exit-chip"
            label="Exit Demo"
            icon={<CloseIcon />}
            color="default"
            onClick={() => _pluginInstance?.stopKiosk()}
            sx={{
              position: 'fixed',
              bottom: 24,
              right: 24,
              zIndex: 9999,
              cursor: 'pointer',
              backgroundColor: 'background.paper',
              boxShadow: 4,
            }}
          />

          {/* Touch hint — pulses every 15s */}
          {hintVisible && !reducedMotion && (
            <Box
              sx={{
                position: 'fixed',
                bottom: 80,
                right: 24,
                zIndex: 9998,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 2,
                py: 1,
                borderRadius: 2,
                backgroundColor: 'background.paper',
                opacity: 0.9,
                pointerEvents: 'none',
                animation: reducedMotion ? undefined : 'rv-touch-hint-pulse 1.2s ease-in-out infinite',
                '@keyframes rv-touch-hint-pulse': {
                  '0%, 100%': { transform: 'scale(1)' },
                  '50%': { transform: 'scale(1.05)' },
                },
              }}
            >
              <TouchAppIcon fontSize="small" />
              <Box component="span" sx={{ fontSize: '0.85rem', fontWeight: 500 }}>
                Touch to interact
              </Box>
            </Box>
          )}
        </>
      )}
    </>
  );
});

// ─── Exports (WelcomeModal integration hook) ────────────────────────────

/**
 * React hook — returns true iff kiosk plugin is active AND a tour is registered
 * for the current model. Used by WelcomeModal parent (ButtonPanel) to decide
 * whether to show the "Start Demo" button.
 *
 * @public @stable v1
 */
export function useKioskHasTour(): boolean {
  const snap = useSyncExternalStore(
    _globalSubscribe,
    () => _pluginInstance?.getSnapshot() ?? { hasTour: false, hasCurrentModelTour: false, isActive: false, tourName: null },
  );
  return snap.hasTour;
}

/** @internal — called by WelcomeModal's "Start Demo" button. */
export function startKioskFromWelcome(): void {
  _pluginInstance?.startKiosk();
}

// Suppress unused-import warning for Button (kept for potential future extension)
export const _unusedKioskUiImports = { Button } as const;
