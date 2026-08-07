// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import {
  RVEmbedViewer,
  type RVEmbedCameraFocusOptions,
  type RVEmbedCameraPose,
  type RVEmbedSignalValue,
} from './rv-embed-viewer';
import type {
  RVEmbedDirectorActionDetail,
  RVEmbedDirectorApi,
  RVEmbedDirectorErrorDetail,
  RVEmbedDirectorScript,
  RVEmbedDirectorStepDetail,
  RVEmbedGhostCursorState,
} from './rv-embed-director';
import { rvEmbedManager } from './rv-embed-manager';
import { RVEmbedUIFragments } from './rv-embed-ui-fragments';

export type RVEmbedRunMode = 'when-visible' | 'manual';
export type RVEmbedInteractiveMode = 'none' | 'orbit-on-click' | 'full';

export interface RVEmbedElementSignalsApi {
  subscribe(name: string, callback: (value: RVEmbedSignalValue) => void): () => void;
  write(name: string, value: RVEmbedSignalValue): void;
}

export interface RVEmbedElementCameraApi {
  focus(nodePath: string, options?: RVEmbedCameraFocusOptions): void;
  tween(pose: RVEmbedCameraPose, durationMs: number): void;
}

export interface RVEmbedElementViewerApi {
  readonly signals: RVEmbedElementSignalsApi;
  readonly camera: RVEmbedElementCameraApi;
  readonly director: RVEmbedDirectorApi;
  play(): Promise<void>;
  pause(): void;
  dispose(): void;
}

export interface RVEmbedReadyDetail {
  viewer: RVEmbedViewer;
  director: string | null;
}

export interface RVEmbedErrorDetail {
  error: unknown;
  message: string;
  director?: RVEmbedDirectorErrorDetail;
  step?: RVEmbedDirectorErrorDetail['step'];
  index?: number;
  iteration?: number;
  recoverable?: boolean;
}

interface ElementSignalSubscription {
  name: string;
  callback: (value: RVEmbedSignalValue) => void;
  unsubscribe: (() => void) | null;
}

export const RV_EMBED_VISIBILITY_THRESHOLD = 0.25;
export const RV_EMBED_DWELL_MS = 200;

const DEFAULT_BACKGROUND = '#1a1d21';
const DEFAULT_DPR_CAP = 1.5;
const RVHTMLElement = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;

export class RVEmbedElement extends RVHTMLElement {
  static readonly observedAttributes = [
    'src',
    'poster',
    'background',
    'run',
    'interactive',
    'dpr-cap',
    'director',
  ];

  readonly viewer: RVEmbedElementViewerApi;

  private canvas: HTMLCanvasElement;
  private readonly poster: HTMLImageElement;
  private readonly ghostCursor: HTMLDivElement;
  private readonly uiFragments: RVEmbedUIFragments;
  private lifecycle: AbortController | null = null;
  private observer: IntersectionObserver | null = null;
  private reducedMotion: MediaQueryList | null = null;
  private engine: RVEmbedViewer | null = null;
  private bootPromise: Promise<RVEmbedViewer | null> | null = null;
  private dwellTimer: ReturnType<typeof setTimeout> | null = null;
  private posterFrame: number | null = null;
  private readonly signalSubscriptions = new Set<ElementSignalSubscription>();
  private visible = false;
  private connected = false;
  private takenOver = false;
  private bootEpoch = 0;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host {
          display: block;
          position: relative;
          min-width: 1px;
          min-height: 1px;
          overflow: hidden;
          contain: layout paint style;
        }
        canvas,
        img {
          position: absolute;
          inset: 0;
          display: block;
          width: 100%;
          height: 100%;
        }
        canvas {
          touch-action: none;
        }
        img {
          z-index: 1;
          object-fit: cover;
          opacity: 1;
          transition: opacity 240ms ease;
          pointer-events: none;
        }
        img[data-hidden="true"] {
          opacity: 0;
        }
        img:not([src]) {
          display: none;
        }
        [part="ghost-cursor"] {
          --rv-cursor-x: 0px;
          --rv-cursor-y: 0px;
          position: absolute;
          top: 0;
          left: 0;
          z-index: 2;
          width: 18px;
          height: 18px;
          border: 2px solid rgba(255, 255, 255, 0.95);
          border-radius: 50%;
          background: rgba(79, 195, 247, 0.3);
          box-shadow: 0 0 0 4px rgba(79, 195, 247, 0.16);
          transform: translate3d(var(--rv-cursor-x), var(--rv-cursor-y), 0) translate(-50%, -50%);
          opacity: 0;
          pointer-events: none;
          transition: opacity 120ms linear;
          will-change: transform;
        }
        [part="ghost-cursor"][data-visible="true"] {
          opacity: 1;
        }
        @media (prefers-reduced-motion: reduce) {
          img {
            transition: none;
          }
        }
      </style>
      <canvas part="canvas"></canvas>
      <img part="poster" alt="" aria-hidden="true">
      <div part="ghost-cursor" data-visible="false" aria-hidden="true"></div>
    `;
    this.canvas = shadow.querySelector('canvas')!;
    this.poster = shadow.querySelector('img')!;
    this.ghostCursor = shadow.querySelector<HTMLDivElement>('[part="ghost-cursor"]')!;
    this.uiFragments = new RVEmbedUIFragments({
      element: this,
      shadowRoot: shadow,
      getInteractiveMode: () => this.interactiveMode,
      subscribeSignal: (name, callback) => this.subscribeSignal(name, callback),
      dragNodeByScreenDelta: (nodePath, deltaX, deltaY) => (
        this.engine?.dragNodeByScreenDelta(nodePath, deltaX, deltaY) ?? null
      ),
      takeOver: () => this.takeOver(),
    });

    this.viewer = {
      signals: {
        subscribe: (name, callback) => this.subscribeSignal(name, callback),
        write: (name, value) => this.requireEngine().signals.write(name, value),
      },
      camera: {
        focus: (nodePath, options) => this.requireEngine().camera.focus(nodePath, options),
        tween: (pose, durationMs) => this.requireEngine().camera.tween(pose, durationMs),
      },
      director: {
        run: (script: RVEmbedDirectorScript) => {
          rvEmbedManager.requestSimulation(this);
          this.requireEngine().director.run(script);
        },
        stop: () => this.engine?.director.stop(),
      },
      play: () => this.manualPlay(),
      pause: () => this.engine?.pause(),
      dispose: () => this.disposeLifecycle(),
    };
    this.updatePoster();
  }

  connectedCallback(): void {
    if (this.connected) return;
    this.connected = true;
    this.takenOver = false;
    this.lifecycle = new AbortController();
    const signal = this.lifecycle.signal;
    this.uiFragments.connect(signal);
    rvEmbedManager.register(this, signal);

    this.addEventListener('click', this.handleTakeover, { signal });
    document.addEventListener('visibilitychange', this.handleDocumentVisibility, { signal });
    window.addEventListener('resize', this.handleResize, { signal });

    this.reducedMotion = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    this.reducedMotion?.addEventListener('change', this.handleReducedMotion, { signal });

    if (typeof IntersectionObserver === 'function') {
      this.observer = new IntersectionObserver(this.handleIntersection, {
        threshold: [0, RV_EMBED_VISIBILITY_THRESHOLD],
      });
      this.observer.observe(this);
      signal.addEventListener('abort', () => this.observer?.disconnect(), { once: true });
    } else {
      this.visible = true;
      rvEmbedManager.setVisible(this, true);
      this.scheduleVisibleBoot();
    }
    signal.addEventListener('abort', () => this.clearScheduledWork(), { once: true });
    this.handleDocumentVisibility();
    this.updatePoster();
  }

  disconnectedCallback(): void {
    this.connected = false;
    this.disposeLifecycle();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return;
    if (name === 'poster') {
      this.updatePoster();
      return;
    }
    if (!this.connected) return;
    switch (name) {
      case 'src':
        this.restartViewer();
        break;
      case 'background':
        this.engine?.setBackground(this.background);
        break;
      case 'dpr-cap':
        this.engine?.setDprCap(this.dprCap);
        break;
      case 'director':
        this.engine?.setDirector(this.director);
        break;
      case 'interactive':
        this.applyInteractiveMode();
        break;
      case 'run':
        this.clearDwellTimer();
        this.scheduleVisibleBoot();
        break;
    }
  }

  get runMode(): RVEmbedRunMode {
    return this.getAttribute('run') === 'manual' ? 'manual' : 'when-visible';
  }

  get interactiveMode(): RVEmbedInteractiveMode {
    const value = this.getAttribute('interactive');
    return value === 'none' || value === 'full' ? value : 'orbit-on-click';
  }

  get background(): string | null {
    const value = this.getAttribute('background');
    return value === 'transparent' ? null : value || DEFAULT_BACKGROUND;
  }

  get dprCap(): number {
    const value = Number(this.getAttribute('dpr-cap'));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_DPR_CAP;
  }

  get director(): string | null {
    return this.getAttribute('director');
  }

  private readonly handleIntersection: IntersectionObserverCallback = (entries) => {
    const entry = entries.find((candidate) => candidate.target === this);
    if (!entry) return;
    const visible = entry.isIntersecting && entry.intersectionRatio >= RV_EMBED_VISIBILITY_THRESHOLD;
    if (visible === this.visible) return;
    this.visible = visible;
    this.engine?.setPaused('offscreen', !visible);
    rvEmbedManager.setVisible(this, visible);
    if (visible) this.scheduleVisibleBoot();
    else this.clearDwellTimer();
  };

  private readonly handleDocumentVisibility = (): void => {
    this.engine?.setPaused('document-hidden', document.hidden);
  };

  private readonly handleResize = (): void => {
    this.resizeEngine();
  };

  private readonly handleReducedMotion = (): void => {
    const reduced = this.reducedMotion?.matches ?? false;
    this.engine?.setPaused('reduced-motion', reduced);
    if (reduced) this.clearDwellTimer();
    else this.scheduleVisibleBoot();
  };

  private readonly handleTakeover = (): void => {
    this.takeOver();
  };

  private takeOver(): void {
    if (!this.engine || this.interactiveMode === 'none' || this.takenOver) return;
    rvEmbedManager.requestSimulation(this);
    this.takenOver = true;
    this.engine.takeOver();
    this.engine.controls.enabled = true;
    this.dispatchEvent(new CustomEvent('rv-user-takeover', {
      bubbles: true,
      composed: true,
      detail: { viewer: this.engine },
    }));
  }

  private scheduleVisibleBoot(): void {
    if (
      !this.connected
      || !this.visible
      || this.runMode !== 'when-visible'
      || this.reducedMotion?.matches
      || this.engine
      || this.bootPromise
      || this.dwellTimer
    ) return;
    this.dwellTimer = setTimeout(() => {
      this.dwellTimer = null;
      if (!this.visible || this.lifecycle?.signal.aborted) return;
      void this.boot(false);
    }, RV_EMBED_DWELL_MS);
  }

  private async manualPlay(): Promise<void> {
    if (!this.connected || this.lifecycle?.signal.aborted) {
      throw new Error('<rv-embed> must be connected before play()');
    }
    rvEmbedManager.requestSimulation(this);
    const engine = await this.boot(true);
    if (!engine) return;
    engine.setPaused('offscreen', false);
    engine.play();
  }

  private boot(manual: boolean): Promise<RVEmbedViewer | null> {
    if (this.engine) {
      if (manual) this.engine.play();
      return Promise.resolve(this.engine);
    }
    if (this.bootPromise) return this.bootPromise;
    const source = this.getAttribute('src')?.trim();
    if (!source) {
      const error = new Error('<rv-embed> requires a non-empty src attribute');
      this.dispatchError(error);
      return Promise.resolve(null);
    }

    const lifecycle = this.lifecycle;
    if (!lifecycle || lifecycle.signal.aborted) return Promise.resolve(null);
    const epoch = ++this.bootEpoch;
    const engine = new RVEmbedViewer({
      canvas: this.canvas,
      dprCap: this.dprCap,
      background: this.background,
      width: this.renderWidth,
      height: this.renderHeight,
      director: this.director,
      directorEvents: {
        step: (detail) => this.dispatchDirectorStep(detail),
        error: (detail) => this.dispatchError(detail.error, detail),
        ghostCursor: (state) => this.updateGhostCursor(state),
        action: (detail) => this.dispatchDirectorAction(detail),
      },
      signal: lifecycle.signal,
    });
    this.engine = engine;
    rvEmbedManager.sync(this);
    this.applyInteractiveMode();
    this.bindSignalSubscriptions(engine);
    this.handleDocumentVisibility();
    engine.setPaused('offscreen', !this.visible && !manual);

    this.bootPromise = (async () => {
      try {
        await rvEmbedManager.enqueueLoad(this, () => engine.loadModel(source));
        if (epoch !== this.bootEpoch || lifecycle.signal.aborted || this.engine !== engine) {
          engine.dispose();
          return null;
        }
        this.resizeEngine();
        engine.play();
        rvEmbedManager.sync(this);
        if (!manual && this.reducedMotion?.matches) engine.setPaused('reduced-motion', true);
        this.dispatchEvent(new CustomEvent<RVEmbedReadyDetail>('rv-ready', {
          bubbles: true,
          composed: true,
          detail: { viewer: engine, director: this.director },
        }));
        this.crossfadePosterAfterFirstFrame();
        return engine;
      } catch (error) {
        if (!isAbortError(error) && epoch === this.bootEpoch && !lifecycle.signal.aborted) {
          this.dispatchError(error);
        }
        if (this.engine === engine) {
          this.unbindSignalSubscriptions();
          this.engine = null;
        }
        engine.dispose();
        return null;
      } finally {
        if (epoch === this.bootEpoch) this.bootPromise = null;
      }
    })();
    return this.bootPromise;
  }

  private restartViewer(): void {
    this.bootEpoch++;
    this.clearDwellTimer();
    this.unbindSignalSubscriptions();
    this.engine?.dispose();
    this.engine = null;
    this.bootPromise = null;
    this.takenOver = false;
    this.uiFragments.clear();
    this.poster.dataset.hidden = 'false';
    this.scheduleVisibleBoot();
  }

  setManagedSimulationActive(active: boolean, resetRegistries: boolean): void {
    if (resetRegistries) this.engine?.resetSharedRegistries();
    this.engine?.setPaused('manager-inactive', !active);
  }

  setManagedScrollMode(active: boolean): void {
    this.engine?.setScrollPerformanceMode(active);
  }

  suspendManagedContext(): boolean {
    const engine = this.engine;
    if (!engine || engine.isDisposed) return false;
    if (engine.isContextSuspended) return true;
    const frame = engine.captureFrame();
    if (frame) this.poster.src = frame;
    this.poster.dataset.hidden = 'false';
    engine.suspendContext();
    return engine.isContextSuspended;
  }

  resumeManagedContext(): boolean {
    const engine = this.engine;
    if (!engine || engine.isDisposed || !engine.isContextSuspended) return false;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('part', 'canvas');
    this.canvas.replaceWith(canvas);
    this.canvas = canvas;
    try {
      engine.resumeContext(canvas, this.background);
      this.applyInteractiveMode();
      this.resizeEngine();
      this.crossfadePosterAfterFirstFrame();
      return !engine.isContextSuspended;
    } catch (error) {
      this.dispatchError(error);
      return false;
    }
  }

  isManagedContextSuspended(): boolean {
    return this.engine?.isContextSuspended ?? false;
  }

  private applyInteractiveMode(): void {
    this.uiFragments.updateInteractiveMode();
    if (this.engine) {
      this.engine.controls.enabled = this.interactiveMode !== 'none' && this.takenOver;
    }
  }

  private subscribeSignal(
    name: string,
    callback: (value: RVEmbedSignalValue) => void,
  ): () => void {
    const subscription: ElementSignalSubscription = {
      name,
      callback,
      unsubscribe: this.engine?.signals.subscribe(name, callback) ?? null,
    };
    this.signalSubscriptions.add(subscription);
    return () => {
      if (!this.signalSubscriptions.delete(subscription)) return;
      subscription.unsubscribe?.();
      subscription.unsubscribe = null;
    };
  }

  private bindSignalSubscriptions(engine: RVEmbedViewer): void {
    for (const subscription of this.signalSubscriptions) {
      subscription.unsubscribe?.();
      subscription.unsubscribe = engine.signals.subscribe(subscription.name, subscription.callback);
    }
  }

  private unbindSignalSubscriptions(): void {
    for (const subscription of this.signalSubscriptions) {
      subscription.unsubscribe?.();
      subscription.unsubscribe = null;
    }
  }

  private requireEngine(): RVEmbedViewer {
    if (!this.engine || !this.engine.loadResult) {
      throw new Error('<rv-embed> is not ready; wait for rv-ready or call viewer.play()');
    }
    return this.engine;
  }

  private get renderWidth(): number {
    const rectWidth = this.getBoundingClientRect().width;
    return Math.max(1, Math.round(rectWidth || this.clientWidth || this.canvas.width || 640));
  }

  private get renderHeight(): number {
    const rectHeight = this.getBoundingClientRect().height;
    return Math.max(1, Math.round(rectHeight || this.clientHeight || this.canvas.height || 400));
  }

  private resizeEngine(): void {
    this.engine?.resize(this.renderWidth, this.renderHeight);
  }

  private updatePoster(): void {
    const source = this.getAttribute('poster');
    if (source) this.poster.src = source;
    else this.poster.removeAttribute('src');
    this.poster.dataset.hidden = 'false';
  }

  private crossfadePosterAfterFirstFrame(): void {
    if (!this.poster.hasAttribute('src')) return;
    if (this.posterFrame !== null) cancelAnimationFrame(this.posterFrame);
    this.posterFrame = requestAnimationFrame(() => {
      this.posterFrame = null;
      if (!this.lifecycle?.signal.aborted) this.poster.dataset.hidden = 'true';
    });
  }

  private dispatchError(error: unknown, director?: RVEmbedDirectorErrorDetail): void {
    const message = error instanceof Error ? error.message : String(error);
    this.dispatchEvent(new CustomEvent<RVEmbedErrorDetail>('rv-error', {
      bubbles: true,
      composed: true,
      detail: {
        error,
        message,
        ...(director ? {
          director,
          step: director.step,
          index: director.index,
          iteration: director.iteration,
          recoverable: director.recoverable,
        } : {}),
      },
    }));
  }

  private dispatchDirectorStep(detail: RVEmbedDirectorStepDetail): void {
    this.dispatchEvent(new CustomEvent<RVEmbedDirectorStepDetail>('rv-director-step', {
      bubbles: true,
      composed: true,
      detail,
    }));
  }

  private dispatchDirectorAction(detail: RVEmbedDirectorActionDetail): void {
    if (detail.type === 'overlay') {
      this.dispatchEvent(new CustomEvent(detail.event, {
        bubbles: true,
        composed: true,
        detail: detail.detail,
      }));
      return;
    }
    const eventName = detail.type === 'click'
      ? 'rv-director-click'
      : detail.type === 'drag'
        ? 'rv-director-drag'
        : 'rv-director-context-menu';
    this.dispatchEvent(new CustomEvent(eventName, {
      bubbles: true,
      composed: true,
      detail,
    }));
  }

  private updateGhostCursor(state: RVEmbedGhostCursorState): void {
    this.ghostCursor.dataset.visible = String(state.visible);
    this.ghostCursor.style.setProperty('--rv-cursor-x', `${state.x}px`);
    this.ghostCursor.style.setProperty('--rv-cursor-y', `${state.y}px`);
  }

  private clearDwellTimer(): void {
    if (this.dwellTimer === null) return;
    clearTimeout(this.dwellTimer);
    this.dwellTimer = null;
  }

  private clearScheduledWork(): void {
    this.clearDwellTimer();
    if (this.posterFrame !== null) {
      cancelAnimationFrame(this.posterFrame);
      this.posterFrame = null;
    }
  }

  private disposeLifecycle(): void {
    this.bootEpoch++;
    this.clearScheduledWork();
    this.lifecycle?.abort();
    this.lifecycle = null;
    this.observer = null;
    this.reducedMotion = null;
    this.unbindSignalSubscriptions();
    this.signalSubscriptions.clear();
    this.engine?.dispose();
    this.engine = null;
    this.bootPromise = null;
    this.visible = false;
    this.takenOver = false;
  }
}

export function defineRVEmbedElement(tagName = 'rv-embed'): void {
  if (typeof customElements === 'undefined' || customElements.get(tagName)) return;
  customElements.define(tagName, RVEmbedElement);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
