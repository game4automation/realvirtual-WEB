// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SoundSystemPlugin — owner of the drive sounds of ONE viewer (plan-2019 C3/C4/C8).
 *
 * Eager and slim on purpose: it keeps the per-viewer list of `Sound` components
 * (from the page-wide hub in `rv-sound.ts`, filtered by this viewer's scene) in
 * a `useSyncExternalStore` store that the Sound segment reads, follows the
 * settings store, and forwards the render frame. The audio path
 * (`src/core/audio/rv-audio-engine.ts`: voice pool, synthesis, sampler) is
 * imported only on the first activation. Only the tiny context starter
 * (`src/core/rv-audio-context.ts`) is eager, because the context has to be
 * created and resumed INSIDE the user gesture — it cannot wait for a chunk.
 *
 * Two off states (C8):
 * - never activated: no AudioContext, the audio module is not even loaded;
 * - switched off after activation: the context is suspended, the voice pool stays.
 *
 * Activation (autoplay rule): a gesture — the segment's pointerdown, the
 * inspector's Preview, or, while sound is on but not yet running, the first
 * pointerdown / keydown of the page — creates / resumes the context synchronously
 * and then loads the engine. The page-wide gesture handlers stay armed until the
 * context actually runs; a refused resume or a failed load re-arms them. An `on`
 * set without a gesture (MCP) is kept and audio starts with the next gesture.
 *
 * Lifecycle (C3): the main viewer does not dispose components on a model change,
 * so `onModelCleared()` and `dispose()` dispose every Sound of this viewer itself.
 * Placement removal and editor remove reach `RVSound.dispose()` through
 * `disposeComponentsInSubtree`.
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import { createStore, type Store } from '../core/hmi/create-store';
import { getRegisteredSounds, subscribeSoundHub, type RVSound } from '../core/engine/rv-sound';
import { getDriveSpeedOverride } from '../core/engine/rv-speed-override';
import { getSoundSettings, soundSettingsStore } from '../core/hmi/sound-settings-store';
import {
  acquireAudioContext, addAudioContextClient, getSharedAudioContext, releaseAudioContext,
  resumeAudioFromGesture, updateContextState,
} from '../core/rv-audio-context';

type AudioModule = typeof import('../core/audio/rv-audio-engine');
type Engine = InstanceType<AudioModule['RVSoundEngine']>;
type FrameInput = import('../core/audio/rv-audio-engine').SoundFrameInput;

export const SOUND_SYSTEM_PLUGIN_ID = 'sound-system';

/** What the Sound segment needs to know about the scene. */
export interface SoundSceneSnapshot {
  /** Number of Sound components in this viewer's scene. */
  readonly count: number;
}

export class SoundSystemPlugin implements RVViewerPlugin {
  readonly id = SOUND_SYSTEM_PLUGIN_ID;
  readonly core = true;

  /** Sound components of this viewer's scene — the segment shows only when count > 0. */
  readonly sceneStore: Store<SoundSceneSnapshot> = createStore<SoundSceneSnapshot>({ count: 0 });

  private _viewer: RVViewer | null = null;
  private _sounds: RVSound[] = [];
  private _mod: AudioModule | null = null;
  private _loading: Promise<AudioModule> | null = null;
  private _engine: Engine | null = null;
  private _offHub: (() => void) | null = null;
  private _offSettings: (() => void) | null = null;
  private _offReset: (() => void) | null = null;
  private _offClient: (() => void) | null = null;
  /** The page-wide pointerdown / keydown handler while armed. */
  private _onGesture: (() => void) | null = null;
  /** This plugin holds one reference on the page context (taken in its first gesture). */
  private _ctxHeld = false;
  /** A gesture asked for audio and the engine is not there yet. */
  private _intent = false;
  /** While a bulk dispose runs, the hub notifications are folded into one sync. */
  private _bulk = false;
  private _disposed = false;
  /** The one frame input, mutated per frame (no allocation in the render path). */
  private readonly _frame: FrameInput = { dt: 0, timeFactor: 1, paused: false, listener: null, motionDt: undefined };
  /** Fixed-step count of the viewer at the previous rendered frame (-1 = not yet read). */
  private _lastStepCount = -1;

  init(viewer: RVViewer): void {
    this._viewer = viewer;
    this._offHub = subscribeSoundHub(() => { if (!this._bulk) this._syncSounds(); });
    this._offSettings = soundSettingsStore.subscribe(() => this._applySettings());
    this._offReset = viewer.on('simulation-reset', () => this._engine?.notifyReset());
    this._offClient = addAudioContextClient(this);
    this._syncSounds();
    if (getSoundSettings().enabled) this._armGesture();
  }

  /** Sound components of this viewer (tests, inspector). */
  get sounds(): readonly RVSound[] { return this._sounds; }
  /** The audio engine, once activated (tests). */
  get engine(): Engine | null { return this._engine; }
  /** True once the audio module was loaded. */
  get loaded(): boolean { return this._mod !== null; }
  /** True while the page-wide gesture handlers wait for a gesture (tests). */
  get gestureArmed(): boolean { return this._onGesture !== null; }
  /** Context client: wants audio while a gesture start waits for the engine (the engine takes over then). */
  get wantsAudio(): boolean { return !this._disposed && this._engine === null && this._intent; }

  /** Load the audio module ahead of a click (segment hover) — no context yet. */
  prefetch(): Promise<AudioModule> {
    if (this._mod) return Promise.resolve(this._mod);
    if (!this._loading) {
      this._loading = import('../core/audio/rv-audio-engine').then(
        (m) => { this._mod = m; return m; },
        (err: unknown) => { this._loading = null; throw err; },
      );
    }
    return this._loading;
  }

  /**
   * Call SYNCHRONOUSLY from a user gesture that turns sound on or previews: creates
   * (or resumes) the page context right here, inside the gesture, then loads the
   * engine. Resolves when the attempt is over; a refused start re-arms the gesture.
   */
  activateFromGesture(): Promise<void> {
    if (this._disposed) return Promise.resolve();
    let running: Promise<boolean>;
    try {
      if (!this._ctxHeld) {
        acquireAudioContext();
        this._ctxHeld = true;
      }
      this._intent = true;
      running = resumeAudioFromGesture();
    } catch (err) {
      // No Web Audio in this browser — nothing to arm for.
      console.warn('[Sound] audio is not available:', err);
      this._intent = false;
      return Promise.resolve();
    }
    return Promise.all([this.prefetch(), running]).then(
      ([m, ok]) => {
        if (this._disposed) return;
        this._activate(m);
        this._intent = false;
        updateContextState();
        if (ok) this._disarmGesture();
        else if (getSoundSettings().enabled) this._armGesture();
      },
      (err: unknown) => {
        console.warn('[Sound] could not start audio:', err);
        this._intent = false;
        updateContextState();
        if (!this._disposed && getSoundSettings().enabled) this._armGesture();
      },
    );
  }

  /** Preview one Sound (inspector button) — also with the global switch off. */
  async preview(sound: RVSound): Promise<void> {
    await this.activateFromGesture();
    this._engine?.preview(sound);
  }

  private _activate(m: AudioModule): void {
    if (this._disposed) return;
    if (!this._engine) {
      this._engine = new m.RVSoundEngine();
      this._engine.activate();
      this._engine.setSources(this._sounds);
    } else if (!this._engine.activated) {
      this._engine.activate();
    }
    const s = getSoundSettings();
    this._engine.setVolume(s.volume);
    this._engine.setEnabled(s.enabled);
  }

  private _applySettings(): void {
    if (this._disposed) return;
    const s = getSoundSettings();
    if (this._engine) {
      this._engine.setVolume(s.volume);
      this._engine.setEnabled(s.enabled);
    }
    if (!s.enabled) {
      this._disarmGesture();
      return;
    }
    if (!this._engine) {
      // Switched on without an engine (MCP, or a click before the module loaded).
      // A context of the page already exists → start right away; otherwise the
      // context must come from a gesture: wait for it (the module loads meanwhile).
      if (getSharedAudioContext()) void this.activateFromGesture();
      else { void this.prefetch().catch(() => { /* retried by the gesture */ }); this._armGesture(); }
      return;
    }
    const ctx = getSharedAudioContext();
    if (!ctx || ctx.state !== 'running') this._armGesture();
  }

  /** Wait for the first pointerdown / keydown of the page and start audio there. */
  private _armGesture(): void {
    if (this._onGesture || this._disposed || typeof window === 'undefined') return;
    const onGesture = (): void => {
      if (!getSoundSettings().enabled) { this._disarmGesture(); return; }
      // Synchronous inside the gesture; the handler stays until the context runs.
      void this.activateFromGesture();
    };
    this._onGesture = onGesture;
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
  }

  private _disarmGesture(): void {
    const h = this._onGesture;
    if (!h) return;
    this._onGesture = null;
    if (typeof window === 'undefined') return;
    window.removeEventListener('pointerdown', h, true);
    window.removeEventListener('keydown', h, true);
  }

  private _syncSounds(): void {
    const scene = this._viewer?.scene ?? null;
    const next: RVSound[] = [];
    for (const s of getRegisteredSounds()) if (scene && s.scene === scene) next.push(s);
    const same = next.length === this._sounds.length && next.every((s, i) => s === this._sounds[i]);
    this._sounds = next;
    // A re-resolve (Kind / Variant edit) keeps the list but changes the voice set-up.
    this._engine?.setSources(next);
    if (!same || this.sceneStore.getSnapshot().count !== next.length) this.sceneStore.set({ count: next.length });
  }

  /**
   * Dispose every Sound of this viewer (snapshot first — dispose edits the hub),
   * empty the engine's sources and the store. The main viewer's `clearModel()` does
   * not dispose components generically, so a model change would otherwise keep the
   * old Sounds (same scene) with their removed drives.
   */
  private _disposeOwnSounds(): void {
    const scene = this._viewer?.scene ?? null;
    const own: RVSound[] = [];
    if (scene) for (const s of getRegisteredSounds()) if (s.scene === scene) own.push(s);
    this._bulk = true;
    try {
      for (const s of own) {
        try { s.dispose(); } catch (e) { console.error('[Sound] dispose failed:', e); }
      }
    } finally {
      this._bulk = false;
    }
    this._sounds = [];
    this._engine?.setSources(this._sounds);
    if (this.sceneStore.getSnapshot().count !== 0) this.sceneStore.set({ count: 0 });
  }

  onRender(frameDt: number): void {
    const engine = this._engine;
    const viewer = this._viewer;
    if (!engine || !viewer || !(engine.enabled || engine.previewing)) { this._lastStepCount = -1; return; }
    const f = this._frame;
    f.dt = frameDt;
    // Simulated motion time of this frame: drives move in whole fixed steps, the frame rate
    // jitters — measuring the speed against wall time made a constant-speed drive wobble.
    const v = viewer as unknown as { fixedStepCount?: number; loop?: { fixedTimeStep?: number } };
    const steps = v.fixedStepCount;
    const step = v.loop?.fixedTimeStep;
    if (typeof steps === 'number' && typeof step === 'number' && step > 0) {
      const delta = this._lastStepCount >= 0 ? steps - this._lastStepCount : -1;
      this._lastStepCount = steps;
      f.motionDt = delta >= 0 ? delta * step : undefined;
    } else {
      f.motionDt = undefined;
    }
    f.timeFactor = getDriveSpeedOverride();
    f.paused = viewer.isSimulationPaused;
    f.listener = this._mod!.listenerCameraOf(viewer as unknown as { camera: import('three').Object3D; renderer?: unknown });
    engine.frame(f);
  }

  /** Present so the viewer delivers `onModelCleared` (it only clears plugins that got the model). */
  onModelLoaded(): void {
    this._syncSounds();
  }

  onModelCleared(): void {
    this._disposeOwnSounds();
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposeOwnSounds();
    this._disposed = true;
    this._disarmGesture();
    this._offHub?.();
    this._offSettings?.();
    this._offReset?.();
    this._offClient?.();
    this._offHub = this._offSettings = this._offReset = this._offClient = null;
    this._intent = false;
    this._engine?.dispose();
    this._engine = null;
    if (this._ctxHeld) {
      this._ctxHeld = false;
      releaseAudioContext();
    }
    this._sounds = [];
    this._viewer = null;
  }
}
