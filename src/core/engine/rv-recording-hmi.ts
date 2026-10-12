// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-recording-hmi — the React HMI inside a frame-by-frame recording (plan-556).
 *
 * A deterministic recording (rv-video-capture) steps the simulation per video frame; for the HMI
 * to appear in the video frame-synchronous with the plant, every frame needs:
 *
 *  1. the 3D frame that is encoded — a same-task snapshot of the frame source — shown as an
 *     UNDERLAY (`bitmaprenderer` canvas above the hidden `#rv-viewport`, below `#react-root`),
 *     so a page screenshot never depends on the WebGL compositor ({@link setUnderlay});
 *  2. the HMI settled on the frame's sim state ({@link captureHmiSettle}): recording ticks
 *     (`flushNow` — every wall-clock read-out timer is REPLACED while recording) → ONE commit
 *     barrier (a frame counter in a store; `RecordingFrameProbe` in App.tsx acknowledges after
 *     React committed it) → every Web Animation frozen at the recording clock (`playbackRate = 0`
 *     + `currentTime`, never `pause()` — Playwright restarts paused infinite animations) → one rAF;
 *  3. the viewer chrome hidden: the UI context `recording` makes App.tsx render the recording shell
 *     (operator panels, the CONNECT panel when open, nothing else) and a style tag hides what lives
 *     outside `#react-root` (ViewCube, watermark, cinematic preview).
 *
 * No Playwright, no files: the CLI (`scripts/lib/rv-record-hmi.mjs`) and the dialog's tab capture
 * (private) drive these functions through `viewer.recordingHmi` and take the screenshot / grab.
 */

import { activateContext, deactivateContext } from '../hmi/ui-context-store';
import { getUIZoom, setUIZoom } from '../hmi/visual-settings-store';
import { flushNow, setRecordingTicks } from '../../hooks/shared-ui-ticker';

// ─── Constants ────────────────────────────────────────────────────────────

/** UI context active while the HMI is recorded (App.tsx renders the recording shell). */
export const RECORDING_CONTEXT = 'recording';
/** Id of the underlay canvas. */
export const RECORDING_UNDERLAY_ID = 'rv-recording-underlay';
const STYLE_ID = 'rv-recording-hmi-style';
const LAYER_STYLE_ID = 'rv-recording-hmi-layer-style';
/** Default bound of one settle step (commit barrier, rAF) in ms (F4/F9). */
export const RECORDING_SETTLE_TIMEOUT_MS = 10_000;
/** Attribute that hides an element for the whole recording (dialogs, progress overlays). */
export const RECORDING_EXCLUDE_ATTR = 'data-rv-recording-exclude';
/** Root attribute set while a grab / screenshot is being prepared (hides `data-rv-recording-grab-exclude`). */
const GRAB_ATTR = 'data-rv-recording-grab';

/**
 * Side panels (`leftPanelManager` ids) whose read-outs are on recording ticks (F4) and that the
 * recording shell renders — the only side-panel ids `--hmi-open` accepts.
 */
export const SUPPORTED_SIDE_PANELS: readonly string[] = ['connect'];

/**
 * Overlay slot entries (by plugin id) the recording shell keeps besides the operator panels. A
 * project plugin can add its own read-only overlay with {@link allowRecordingOverlay}.
 */
const overlayAllowlist = new Set<string>(['web-operator-panels']);

/** Keep an overlay slot entry of this plugin in recordings (it must be on recording ticks). */
export function allowRecordingOverlay(pluginId: string): void {
  overlayAllowlist.add(pluginId);
}

/** True when an overlay slot entry of `pluginId` stays in a recording. */
export function isRecordingOverlayAllowed(pluginId: string | undefined, isOperatorPanel: boolean): boolean {
  return isOperatorPanel || (!!pluginId && overlayAllowlist.has(pluginId));
}

const RECORDING_CSS = [
  // Full-bleed viewport: the composite is the browser viewport (DSF 1), the HMI lays out on it.
  '#rv-viewport{left:0 !important;top:0 !important;right:0 !important;bottom:0 !important;width:100vw !important;height:100vh !important}',
  // Outside #react-root: ViewCube, the AGPL watermark (the recording shows the plant, the
  // watermark stays on every interactive page), anything marked as excluded.
  `#rv-watermark,.rv-orientation-gizmo,[${RECORDING_EXCLUDE_ATTR}]{visibility:hidden !important}`,
  `html[${GRAB_ATTR}] [data-rv-recording-grab-exclude]{visibility:hidden !important}`,
  // Cinematic preview canvas: opacity, not display:none (its WebGPU presentation keeps running).
  '[data-rv-cinematic-preview]{opacity:0 !important}',
  // No blinking caret in a frame.
  '*{caret-color:transparent !important}',
].join('\n');

const LAYER_CSS = [
  'html,body,#react-root{background:transparent !important;background-color:transparent !important}',
  `#${RECORDING_UNDERLAY_ID},#rv-viewport{visibility:hidden !important}`,
].join('\n');

// ─── Host ─────────────────────────────────────────────────────────────────

/** What the recording HMI needs from the viewer (structural — tests pass a fake). */
export interface RecordingHmiHost {
  leftPanelManager?: {
    open(id: string, width: number, anchor?: 'left' | 'right'): void;
    close(id: string): void;
    getActive(side: 'left' | 'right'): string | null;
  } | null;
  webOperatorPanels?: { getEntries(): ReadonlyArray<{ panelId: string }> } | null;
  /** Ids of operator panels registered as plugins (`OperatorPanelPlugin`). */
  operatorPanelPluginIds?(): string[];
}

// ─── Active state (App.tsx subscribes) ───────────────────────────────────

let active = false;
let generation = 0;
const activeListeners = new Set<() => void>();

function notifyActive(): void {
  for (const l of Array.from(activeListeners)) l();
}

/** True while a recording HMI session is active. */
export function isRecordingHmiActive(): boolean {
  return active;
}

/** Subscribe to the active state (useSyncExternalStore). */
export function subscribeRecordingHmi(listener: () => void): () => void {
  activeListeners.add(listener);
  return () => { activeListeners.delete(listener); };
}

/** Increments on every enter / exit — a late callback of an older session compares it (F9). */
export function recordingGeneration(): number {
  return generation;
}

// ─── Commit barrier (F4) ─────────────────────────────────────────────────

let frameCounter = 0;
const frameListeners = new Set<() => void>();
const pendingAcks = new Map<number, (ms: number) => void>();
const ackStart = new Map<number, number>();

/** useSyncExternalStore subscribe of the recording frame counter (RecordingFrameProbe). */
export function subscribeRecordingFrame(listener: () => void): () => void {
  frameListeners.add(listener);
  return () => { frameListeners.delete(listener); };
}

/** The recording frame counter (RecordingFrameProbe's snapshot). */
export function getRecordingFrame(): number {
  return frameCounter;
}

/** Called by RecordingFrameProbe in a layout effect: React committed frame `f` (and everything before it). */
export function ackRecordingFrame(f: number): void {
  for (const [k, resolve] of Array.from(pendingAcks)) {
    if (k > f) continue;
    pendingAcks.delete(k);
    const t0 = ackStart.get(k) ?? performance.now();
    ackStart.delete(k);
    resolve(performance.now() - t0);
  }
}

/**
 * Bumps the frame counter and resolves (ack latency, ms) once React committed it. Without a
 * mounted probe (no React HMI) it resolves at once with -1. Rejects after `timeoutMs`.
 */
export function commitBarrier(timeoutMs = RECORDING_SETTLE_TIMEOUT_MS, signal?: AbortSignal): Promise<number> {
  frameCounter++;
  const f = frameCounter;
  if (frameListeners.size === 0) return Promise.resolve(-1);
  return new Promise<number>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (fn: () => void): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pendingAcks.delete(f);
      ackStart.delete(f);
      fn();
    };
    const onAbort = (): void => done(() => reject(new Error('Recording aborted.')));
    pendingAcks.set(f, (ms) => done(() => resolve(ms)));
    ackStart.set(f, performance.now());
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => done(() => reject(new Error(`The HMI did not commit frame ${f} within ${Math.round(timeoutMs / 1000)} s.`))), timeoutMs);
    for (const l of Array.from(frameListeners)) l();
  });
}

// ─── Recording clock + animation freeze (F4) ─────────────────────────────

let clockMs = 0;
const frozen = new Set<Animation>();

/** The recording clock (ms of sim time of the frame being settled). */
export function recordingNow(): number {
  return clockMs;
}

/**
 * Freezes every Web Animation of the document at `ms`: `playbackRate = 0` + `currentTime`. NOT
 * `pause()` — Playwright's `animations: 'disabled'` cancels and restarts paused infinite
 * animations, a rate-0 one is skipped (plan-556 spike). Returns how many were frozen.
 */
export function freezeAnimations(ms: number): number {
  if (typeof document === 'undefined' || typeof document.getAnimations !== 'function') return 0;
  let n = 0;
  for (const a of document.getAnimations()) {
    if (!frozen.has(a)) frozen.add(a);
    a.playbackRate = 0;
    a.currentTime = ms;
    n++;
  }
  return n;
}

/** Restarts every animation {@link freezeAnimations} stopped (at its frozen phase). */
function thawAnimations(): void {
  for (const a of frozen) {
    try { a.playbackRate = 1; } catch { /* finished / removed */ }
  }
  frozen.clear();
}

function nextAnimationFrame(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No animation frame within ${Math.round(timeoutMs / 1000)} s — is the recording tab hidden?`)), timeoutMs);
    requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
  });
}

export interface HmiSettleResult {
  /** Ticker callbacks run by `flushNow`. */
  flushed: number;
  /** Commit-barrier latency (ms, -1 = no probe mounted). */
  ackMs: number;
  /** Animations frozen at the recording clock. */
  frozen: number;
  /** Whole settle (ms). */
  totalMs: number;
}

/**
 * Settles the HMI on the current sim state for one video frame (F4): recording clock = `simTimeMs`,
 * ticker flush, ONE commit barrier, animation freeze after the commit, one animation frame. Every
 * step is bounded by `timeoutMs` and abortable.
 */
export async function captureHmiSettle(
  simTimeMs: number,
  o: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<HmiSettleResult> {
  const t0 = performance.now();
  const timeoutMs = o.timeoutMs ?? RECORDING_SETTLE_TIMEOUT_MS;
  clockMs = simTimeMs;
  const flushed = flushNow();
  const ackMs = await commitBarrier(timeoutMs, o.signal);
  const n = freezeAnimations(simTimeMs);
  if (o.signal?.aborted) throw new Error('Recording aborted.');
  await nextAnimationFrame(timeoutMs);
  return { flushed, ackMs, frozen: n, totalMs: performance.now() - t0 };
}

// ─── Underlay (F5) ────────────────────────────────────────────────────────

function viewportEl(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('rv-viewport');
}

/**
 * Shows `bitmap` (the same-task snapshot of the encoded 3D frame) as the underlay: a
 * `bitmaprenderer` canvas (ownership of the bitmap is transferred — no PNG encode in the page)
 * above the hidden `#rv-viewport`, below `#react-root`. `bottomCss` leaves a band at the bottom
 * free (the tab-capture marker). `null` removes it and shows the viewport again.
 */
export function setUnderlay(bitmap: ImageBitmap | null, o: { bottomCss?: number } = {}): void {
  let c = document.getElementById(RECORDING_UNDERLAY_ID) as HTMLCanvasElement | null;
  const vp = viewportEl();
  if (!bitmap) {
    c?.remove();
    if (vp) vp.style.visibility = '';
    return;
  }
  if (!c) {
    c = document.createElement('canvas');
    c.id = RECORDING_UNDERLAY_ID;
    c.setAttribute('aria-hidden', 'true');
    document.body.appendChild(c);
  }
  const bottom = Math.max(0, o.bottomCss ?? 0);
  c.style.cssText = `position:fixed;left:0;top:0;width:100vw;height:calc(100vh - ${bottom}px);z-index:999;pointer-events:none;display:block`;
  if (c.width !== bitmap.width) c.width = bitmap.width;
  if (c.height !== bitmap.height) c.height = bitmap.height;
  const ctx = c.getContext('bitmaprenderer') as ImageBitmapRenderingContext | null;
  if (!ctx) throw new Error('The recording underlay needs a bitmaprenderer canvas.');
  ctx.transferFromImageBitmap(bitmap);
  if (vp) vp.style.visibility = 'hidden';
}

/** {@link setUnderlay} from PNG bytes (the cinematic frame) — decoded, never re-encoded. */
export async function setUnderlayPng(png: Uint8Array | null, o: { bottomCss?: number } = {}): Promise<void> {
  if (!png) { setUnderlay(null); return; }
  const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }));
  setUnderlay(bitmap, o);
}

function setStyle(id: string, css: string | null): void {
  let s = document.getElementById(id);
  if (css === null) { s?.remove(); return; }
  if (!s) {
    s = document.createElement('style');
    s.id = id;
    document.head.appendChild(s);
  }
  if (s.textContent !== css) s.textContent = css;
}

/**
 * Layer mode (F6): `html, body, #react-root` transparent, underlay and viewport hidden — a
 * screenshot with `omitBackground` is then the HMI alone with straight alpha. `false` restores.
 */
export function setLayerMode(on: boolean): void {
  setStyle(LAYER_STYLE_ID, on ? LAYER_CSS : null);
}

/** Marks the moments a grab / screenshot is prepared (hides `data-rv-recording-grab-exclude`). */
export function setRecordingGrab(on: boolean): void {
  if (typeof document === 'undefined') return;
  if (on) document.documentElement.setAttribute(GRAB_ATTR, '');
  else document.documentElement.removeAttribute(GRAB_ATTR);
}

// ─── Panels (F1/F4) ──────────────────────────────────────────────────────

/** Ids `--hmi-open` accepts: operator panels of the model / plugins + the supported side panels. */
export function recordingPanelIds(host: RecordingHmiHost): { operator: string[]; side: string[] } {
  const operator = new Set<string>();
  for (const e of host.webOperatorPanels?.getEntries() ?? []) operator.add(e.panelId);
  for (const id of host.operatorPanelPluginIds?.() ?? []) operator.add(id);
  return { operator: [...operator].sort(), side: [...SUPPORTED_SIDE_PANELS] };
}

/** Refusal of `--hmi-open` ids that are not supported (naming the supported list), or null. */
export function validateHmiOpen(host: RecordingHmiHost, ids: readonly string[]): string | null {
  const { operator, side } = recordingPanelIds(host);
  const ok = new Set([...operator, ...side]);
  const bad = ids.filter((id) => !ok.has(id));
  if (bad.length === 0) return null;
  const list = [...operator, ...side];
  return `--hmi-open: unsupported panel id${bad.length > 1 ? 's' : ''} ${bad.map((b) => `"${b}"`).join(', ')} — supported: ${list.length ? list.join(', ') : '(none in this model)'}.`;
}

const COLLAPSED_PREFIX = 'rv-panel-collapsed:';
/** localStorage values replaced for the session (restored on exit). */
const restoredStorage = new Map<string, string | null>();
const openedSidePanels: string[] = [];

function setStorage(key: string, value: string): void {
  try {
    if (!restoredStorage.has(key)) restoredStorage.set(key, localStorage.getItem(key));
    localStorage.setItem(key, value);
  } catch { /* storage disabled — the panel keeps its state */ }
}

function restoreStorage(): void {
  for (const [key, value] of restoredStorage) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch { /* storage disabled */ }
  }
  restoredStorage.clear();
}

// ─── Enter / exit ─────────────────────────────────────────────────────────

export interface EnterRecordingHmiOptions {
  /** Panels to open: operator panel ids are expanded, side panels opened (validated beforehand). */
  open?: readonly string[];
  /** Width (CSS px) a side panel opens with (default 420). */
  sidePanelWidth?: number;
}

export interface EnterRecordingHmiResult {
  /** `unsupported panel visible: <id>` lines for panels outside the supported list (F4). */
  warnings: string[];
  generation: number;
}

let savedZoom: number | null = null;

/**
 * Starts a recording HMI session: recording ticks replace the wall-clock timers, the UI context
 * `recording` switches App.tsx to the recording shell, UI zoom 1, the chrome style, and the
 * requested panels opened. Idempotent; pair with {@link exitRecordingHmi} in `finally`.
 */
export function enterRecordingHmi(host: RecordingHmiHost, o: EnterRecordingHmiOptions = {}): EnterRecordingHmiResult {
  const warnings: string[] = [];
  const { operator } = recordingPanelIds(host);
  const lpm = host.leftPanelManager ?? null;
  for (const side of ['left', 'right'] as const) {
    const id = lpm?.getActive(side);
    if (id && !SUPPORTED_SIDE_PANELS.includes(id) && !(o.open ?? []).includes(id)) {
      warnings.push(`unsupported panel visible: ${id} (it is not part of the recording)`);
    }
  }
  for (const id of o.open ?? []) {
    if (operator.includes(id)) setStorage(`${COLLAPSED_PREFIX}${id}`, '0');
    else if (SUPPORTED_SIDE_PANELS.includes(id) && lpm && lpm.getActive('left') !== id && lpm.getActive('right') !== id) {
      lpm.open(id, o.sidePanelWidth ?? 420);
      openedSidePanels.push(id);
    }
  }
  if (!active) {
    active = true;
    generation++;
    setRecordingTicks(true);
    savedZoom = getUIZoom();
    if (savedZoom !== 1) setUIZoom(1);
    setStyle(STYLE_ID, RECORDING_CSS);
    activateContext(RECORDING_CONTEXT);
    notifyActive();
  }
  return { warnings, generation };
}

/** Ends the session and restores everything {@link enterRecordingHmi} and the frames changed. */
export function exitRecordingHmi(host?: RecordingHmiHost | null): void {
  if (typeof document !== 'undefined') {
    setLayerMode(false);
    setRecordingGrab(false);
    setUnderlay(null);
    setStyle(STYLE_ID, null);
  }
  thawAnimations();
  // Abandoned barriers of this session resolve no frame any more.
  pendingAcks.clear();
  ackStart.clear();
  restoreStorage();
  const lpm = host?.leftPanelManager;
  for (const id of openedSidePanels.splice(0)) lpm?.close(id);
  if (!active) return;
  active = false;
  generation++;
  if (savedZoom !== null && savedZoom !== 1) setUIZoom(savedZoom);
  savedZoom = null;
  deactivateContext(RECORDING_CONTEXT);
  setRecordingTicks(false);
  notifyActive();
}

/**
 * The page-side API the CLI and the dialog drive (exposed as `viewer.recordingHmi`). Bound to
 * the viewer so `page.evaluate` can call it without imports.
 */
export function createRecordingHmiApi(host: RecordingHmiHost) {
  return {
    enter: (o?: EnterRecordingHmiOptions) => enterRecordingHmi(host, o),
    exit: () => exitRecordingHmi(host),
    isActive: isRecordingHmiActive,
    generation: recordingGeneration,
    settle: captureHmiSettle,
    setUnderlay,
    setUnderlayPng,
    setLayerMode,
    setGrab: setRecordingGrab,
    panelIds: () => recordingPanelIds(host),
    validateOpen: (ids: readonly string[]) => validateHmiOpen(host, ids),
    now: recordingNow,
  };
}

export type RecordingHmiApi = ReturnType<typeof createRecordingHmiApi>;

/** Test seam: back to the initial state. */
export function _resetRecordingHmi(): void {
  exitRecordingHmi(null);
  frameCounter = 0;
  clockMs = 0;
}
