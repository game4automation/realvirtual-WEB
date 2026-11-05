// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * stage-record-facades — the narrow PluginContext capabilities a runtime-stage
 * recording needs (plan-2229 Phase 3, spike S2/S4):
 *
 *   ctx.stage      — model root, MU templates, pre-placed and spawned MUs, the
 *                    live MU inventory (replaces `LoadResult.transportManager`)
 *   ctx.simTime    — time of the pose the scene shows after `TickStage.POST`,
 *                    the recording refusal of the current kernel, the speed factor
 *   ctx.simCapture — deterministic stepping over the viewer's capture seams
 *
 * Every factory takes a STRUCTURAL host, so `PluginContextImpl` binds it to the
 * viewer and a test binds it to a fake (plugins rule 1: a capability the
 * context lacks is added to the context, not taken from the viewer).
 *
 * NOT in the boot set (tier-boundary 7): the core holds only the interfaces and
 * the optional members; the USD feature imports this module when it loads and
 * calls {@link installStageRecordCapabilities}.
 */

import { Vector2, type Object3D } from 'three';
import type { RVTransportManager } from '../engine/rv-transport-manager';
import { getMuSource } from '../engine/rv-source';
import { getDriveSpeedOverride } from '../engine/rv-speed-override';
import { collectStageInput } from '../usd/collect-stage-input';
import type { MuExportEntry } from '../usd/mu-export';
import { PluginContextImpl } from '../rv-plugin-context';
import type { RVViewer } from '../rv-viewer';
import type {
  SimCaptureFacade,
  SimCaptureSession,
  SimTimeFacade,
  StageInputFacade,
  StageInputSnapshot,
  StageMu,
} from '../usd/stage-record-types';

/** Why a recording is refused while DES runs (S-Q5: DES-Live is a v2 candidate). */
export const DES_RECORD_REFUSAL =
  'Recording a USD animation is not supported in DES mode yet (the DES part visuals are not visible to the recorder).';

// ─── ctx.stage ───────────────────────────────────────────────────────────

/** What `ctx.stage` reads from the viewer (RVViewer satisfies it). */
export interface StageInputHost {
  readonly loadGeneration: number;
  readonly transportManager: RVTransportManager | null;
  readonly currentModelRoot: Object3D | null;
}

/** The export entry of one MU: its own node, or (instanced pool slot) its source template. */
function muEntryOf(mu: StageMu, preplaced: boolean): MuExportEntry {
  return {
    muId: mu.id,
    node: mu.isInstanced ? null : mu.node,
    template: mu.isInstanced ? (getMuSource(mu)?.muTemplate ?? null) : null,
    preplaced,
  };
}

export function createStageInputFacade(host: StageInputHost): StageInputFacade {
  return {
    get generation() { return host.loadGeneration; },
    collect(): StageInputSnapshot | null {
      const root = host.currentModelRoot;
      const tm = host.transportManager;
      if (!root || !tm) return null;
      const { input } = collectStageInput({ root, transportManager: tm }, { timeline: true });
      const seen = new Set<number>();
      const mus: MuExportEntry[] = [];
      // Pre-placed first: once activated (sim start) they are ALSO in `mus`.
      for (const mu of tm.preplacedMUs) {
        if (seen.has(mu.id)) continue;
        seen.add(mu.id);
        mus.push(muEntryOf(mu as unknown as StageMu, true));
      }
      for (const mu of tm.mus) {
        if (seen.has(mu.id)) continue;
        seen.add(mu.id);
        mus.push(muEntryOf(mu as unknown as StageMu, (mu as { preplaced?: boolean }).preplaced === true));
      }
      return { generation: host.loadGeneration, input, mus };
    },
    forEachMu(fn) {
      const list = host.transportManager?.mus;
      if (!list) return;
      for (let i = 0; i < list.length; i++) fn(list[i] as unknown as StageMu);
    },
    muEntry(mu) {
      return muEntryOf(mu, (mu as { preplaced?: boolean }).preplaced === true);
    },
  };
}

// ─── ctx.simTime ─────────────────────────────────────────────────────────

/** What `ctx.simTime` reads from the viewer (RVViewer satisfies it). */
export interface SimTimeHost {
  readonly simTime: number;
  readonly simulationKernel: {
    desControl(): { readonly simTime: number; readonly renderClock?: number } | null;
  } | null;
}

export function createSimTimeFacade(host: SimTimeHost, speedOf: () => number = getDriveSpeedOverride): SimTimeFacade {
  const des = () => host.simulationKernel?.desControl() ?? null;
  return {
    get kernel() {
      if (!host.simulationKernel) return 'none';
      return des() ? 'des' : 'continuous';
    },
    get poseTime() {
      // S4: under DES `viewer.simTime` is the EVENT time; the tweens show the render clock.
      const d = des();
      if (d) return d.renderClock ?? d.simTime;
      return host.simTime;
    },
    get recordRefusal() {
      return des() ? DES_RECORD_REFUSAL : null;
    },
    get speed() { return speedOf(); },
  };
}

// ─── ctx.simCapture ──────────────────────────────────────────────────────

/** The viewer's capture seams (plan-537) as `ctx.simCapture` uses them. */
export interface SimCaptureHost {
  capturePreflight(): string | null;
  beginCapture(opts: { width: number; height: number; frameDt: number }): void;
  captureStep(steps: number, fixedDt?: number): void;
  endCapture(): void;
  readonly captureAbortReason: string | null;
  readonly renderer?: unknown;
}

const FIXED_DT = 1 / 60;

/** Current drawing-buffer size, so beginCapture() changes no visible resolution. */
function rendererSize(host: SimCaptureHost): { width: number; height: number } {
  const v = new Vector2(1, 1);
  try { (host.renderer as { getSize?(out: Vector2): Vector2 } | undefined)?.getSize?.(v); } catch { /* keep 1x1 */ }
  return { width: Math.max(1, Math.round(v.x)), height: Math.max(1, Math.round(v.y)) };
}

export function createSimCaptureFacade(host: SimCaptureHost): SimCaptureFacade {
  return {
    preflight: () => host.capturePreflight(),
    begin() {
      const reason = host.capturePreflight();
      if (reason) return { refusal: reason };
      try {
        host.beginCapture({ ...rendererSize(host), frameDt: FIXED_DT });
      } catch (e) {
        try { host.endCapture(); } catch { /* nothing taken */ }
        return { refusal: e instanceof Error ? e.message : String(e) };
      }
      let ended = false;
      const session: SimCaptureSession = {
        step(ticks: number) {
          if (ended) throw new Error('Capture session already ended');
          host.captureStep(ticks, FIXED_DT);
        },
        get abortReason() { return ended ? null : host.captureAbortReason; },
        end() {
          if (ended) return;
          ended = true;
          host.endCapture();
        },
      };
      return { session };
    },
  };
}

// ─── Installation on the PluginContext ──────────────────────────────────

/** The facades one context created (lazily, on first read). */
interface Installed { stage?: StageInputFacade; simTime?: SimTimeFacade; simCapture?: SimCaptureFacade }
/** Per-context cache, weak so a dropped context frees its facades. */
const perContext = new WeakMap<object, Installed>();
/**
 * The viewer a `PluginContextImpl` is bound to. Its `_viewer` field is private
 * in TypeScript only; reading it here keeps the boot-set class free of any
 * recording code (the getters live in this lazily loaded module).
 */
const viewerOf = (ctx: object): RVViewer => (ctx as unknown as { _viewer: RVViewer })._viewer;
const cacheOf = (ctx: object): Installed => {
  let c = perContext.get(ctx);
  if (!c) { c = {}; perContext.set(ctx, c); }
  return c;
};

/**
 * The five members, as property descriptors defined on the prototype. One
 * constant object, so a cleanup can tell its own descriptors (same getter /
 * value function) from ones another party defined later.
 * `stage` stays null without a model or transport manager (live getter); the
 * other facades are created once per context and then reused.
 */
const CAPABILITIES: PropertyDescriptorMap = {
  stage: {
    configurable: true,
    get(this: object) {
      const v = viewerOf(this);
      if (!v.transportManager || !v.currentModelRoot) return null;
      const c = cacheOf(this);
      return (c.stage ??= createStageInputFacade(v));
    },
  },
  simTime: { configurable: true, get(this: object) { const c = cacheOf(this); return (c.simTime ??= createSimTimeFacade(viewerOf(this))); } },
  simCapture: { configurable: true, get(this: object) { const c = cacheOf(this); return (c.simCapture ??= createSimCaptureFacade(viewerOf(this))); } },
  loadGeneration: { configurable: true, get(this: object) { return viewerOf(this).loadGeneration; } },
  whenSceneReady: { configurable: true, writable: true, value(this: object) { return viewerOf(this).whenSceneReady(); } },
};

/** Owner tokens per prototype: the descriptors stay while any installation owns them. */
const owners = new WeakMap<object, Set<symbol>>();

/**
 * Install `stage` / `simTime` / `simCapture` / `loadGeneration` /
 * `whenSceneReady` on `PluginContextImpl.prototype` (the USD feature calls it
 * when it loads, before it registers the recorder). Every context — created
 * before or after — gets them; facades are cached per context and stay
 * synchronous.
 *
 * Ownership-aware: every call returns its own idempotent cleanup. The
 * descriptors are removed only when the LAST owner cleans up, and only if
 * they are still the ones installed here (a stale cleanup never deletes
 * descriptors someone else defined).
 */
export function installStageRecordCapabilities(proto: object = PluginContextImpl.prototype): () => void {
  let set = owners.get(proto);
  if (!set) { set = new Set(); owners.set(proto, set); }
  // The first owner defines; later owners only add their token.
  if (set.size === 0) Object.defineProperties(proto, CAPABILITIES);
  const token = Symbol('stage-record-capabilities');
  set.add(token);
  return () => {
    const s = owners.get(proto);
    // Idempotent: a token already removed, or other owners left, change nothing.
    if (!s?.delete(token) || s.size > 0) return;
    // Last owner: remove only descriptors that are still ours.
    for (const [k, d] of Object.entries(CAPABILITIES)) {
      const now = Object.getOwnPropertyDescriptor(proto, k);
      if (now && now.get === d.get && now.value === d.value) delete (proto as Record<string, unknown>)[k];
    }
  };
}
