// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-audio-context.ts — the page's ONE AudioContext (plan-2019 §2.6), and nothing else.
 *
 * EAGER on purpose and tiny: browsers (Safari above all) unlock audio only when the
 * context is created / resumed INSIDE the user gesture. The gesture cannot wait for the
 * lazy audio module (`src/core/audio/`, voice pool + synthesis), so creating and
 * resuming the context lives here; everything that makes sound stays lazy.
 *
 * - Reference counted: every holder (an engine, a SoundSystem that started the context
 *   from a gesture) acquires once and releases once; the last release `close()`s it.
 * - Desired state: the context should run while any registered client wants audio and
 *   the page is visible, else be suspended (`visibilitychange`).
 * - `resume()` / `suspend()` are promises that can finish in any order. Every
 *   transition gets a generation; when ANY of them settles, the context is compared
 *   with the CURRENT desired state again and corrected. A fast on/off or hide/show
 *   therefore always ends in the state last asked for. A resume the browser refused
 *   (no gesture yet) is not retried automatically — the next gesture does it.
 */

/** Something that may want the context running (an engine, a pending gesture start). */
export interface AudioContextClient {
  readonly wantsAudio: boolean;
}

type ContextFactory = () => AudioContext;
type Transition = 'resume' | 'suspend';

let _factory: ContextFactory | null = null;
let _ctx: AudioContext | null = null;
let _refs = 0;
let _visibilityBound = false;
let _gen = 0;
let _resumeBlocked = false;
const _clients = new Set<AudioContextClient>();

/** TEST SEAM: replace the AudioContext constructor (null = the browser's). */
export function setAudioContextFactory(factory: ContextFactory | null): void {
  _factory = factory;
}

/** The page's context, or null when none exists. */
export function getSharedAudioContext(): AudioContext | null {
  return _ctx;
}

/** Number of holders of the context. */
export function getAudioContextRefCount(): number {
  return _refs;
}

/** Register a client whose `wantsAudio` decides (with the others) whether the context runs. */
export function addAudioContextClient(client: AudioContextClient): () => void {
  _clients.add(client);
  return () => {
    if (_clients.delete(client)) updateContextState();
  };
}

function createContext(): AudioContext {
  if (_factory) return _factory();
  const w = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio is not available in this browser');
  return new Ctor();
}

function onVisibility(): void {
  updateContextState();
}

/** Acquire the page context (creates it on the first call — call inside a user gesture). */
export function acquireAudioContext(): AudioContext {
  if (!_ctx) {
    _ctx = createContext();
    _resumeBlocked = false;
  }
  _refs++;
  if (!_visibilityBound && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
    _visibilityBound = true;
  }
  return _ctx;
}

/** Release one reference; the last one closes the context. */
export function releaseAudioContext(): void {
  if (_refs <= 0) return;
  _refs--;
  if (_refs > 0 || !_ctx) return;
  const ctx = _ctx;
  _ctx = null;
  if (_visibilityBound && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility);
    _visibilityBound = false;
  }
  void ctx.close().catch(() => { /* already closed */ });
}

function wantsRunning(): boolean {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  for (const c of _clients) if (c.wantsAudio) return true;
  return false;
}

function isClosed(ctx: AudioContext): boolean {
  return (ctx.state as string) === 'closed';
}

/** Start one transition; resolves true when it reached its target state. */
function transition(ctx: AudioContext, op: Transition): Promise<boolean> {
  const gen = ++_gen;
  let p: Promise<void>;
  try {
    p = op === 'resume' ? ctx.resume() : ctx.suspend();
  } catch (e) {
    p = Promise.reject(e);
  }
  return p.then(() => settle(ctx, gen, op, true), () => settle(ctx, gen, op, false));
}

function settle(ctx: AudioContext, gen: number, op: Transition, ok: boolean): boolean {
  const reached = ok && (ctx.state as string) === (op === 'resume' ? 'running' : 'suspended');
  if (op === 'resume') _resumeBlocked = !ok;
  // Compare with what is wanted NOW — a later on/off or hide/show may have overtaken this one.
  if (ctx === _ctx && !isClosed(ctx)) reconcile(ctx, gen === _gen ? op : null);
  return reached;
}

/**
 * Bring the context to the desired state. `latest` = the transition that just settled
 * when it was the newest one: it is not repeated (no retry loop when a browser leaves
 * the state unchanged).
 */
function reconcile(ctx: AudioContext, latest: Transition | null): void {
  const want = wantsRunning();
  const state = ctx.state as string;
  if (want && state !== 'running') {
    if (_resumeBlocked || latest === 'resume') return;
    void transition(ctx, 'resume');
  } else if (!want && state === 'running') {
    if (latest === 'suspend') return;
    void transition(ctx, 'suspend');
  }
}

/** Running while a client wants audio and the page is visible; otherwise suspended. */
export function updateContextState(): void {
  const ctx = _ctx;
  if (!ctx || isClosed(ctx)) return;
  reconcile(ctx, null);
}

/**
 * Resume the context from a user gesture — call synchronously inside the event handler.
 * Clears a refused resume, so the browser gets its chance; afterwards the context
 * follows the desired state again. Resolves true when the context runs.
 */
export function resumeAudioFromGesture(): Promise<boolean> {
  const ctx = _ctx;
  if (!ctx || isClosed(ctx)) return Promise.resolve(false);
  _resumeBlocked = false;
  if ((ctx.state as string) === 'running') return Promise.resolve(true);
  return transition(ctx, 'resume');
}
