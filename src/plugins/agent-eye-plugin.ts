// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * agent-eye-plugin.ts — lifecycle and interaction for the AI agent's camera
 * body (plan-740 Phase 1, §2.6).
 *
 * Owns: the {@link AgentEye} instance reachable as `viewer.agentEye`, the cone
 * gizmo in the scene, the double-click attach and every auto-detach path.
 * The pose maths lives in the core module; nothing here knows about MCP tools.
 *
 * A core plugin, so it is present in every workspace mode. The EMBED viewer
 * loads no plugins at all (rv-embed-viewer.ts) — there it is simply absent, and
 * with it the cone and any agent camera (D-A18).
 *
 * Interaction contract:
 *   - Double-click ON the cone → attach (viewport follows the body), and the
 *     event is stopped so the viewer's own focus double-click does not also
 *     fire. Double-click ANYWHERE ELSE while attached → detach, and the event
 *     runs on normally so the focus jump still happens (D-A5).
 *   - The first user drag (`controls` `'start'`), any programmatic camera
 *     flight (guarded inside `CameraManager.animateCameraTo`), FPV entry and an
 *     XR session start all detach (D-A6).
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { AgentEye, type AgentEyeState, type ViewportPoseSnapshot } from '../core/engine/rv-agent-eye';
import { AgentEyeGizmo } from '../core/engine/rv-agent-eye-gizmo';
import { AgentEyeFollowSource } from '../core/engine/rv-agent-eye-follow-source';
import { EyeChannels, type EyeChannelHost } from '../core/engine/rv-eye-channels';
import { deriveModelKey } from '../core/engine/rv-model-key';
import { loadVisualSettings } from '../core/hmi/visual-settings-store';
import { getAgentEyeLatestSeq, subscribeAgentEye } from '../core/hmi/agent-eye-monitor-store';

/** Extra pixels around the cone's screen box that still count as a hit (D-A5). */
const ATTACH_MAGNET_PX = 12;

/** Time the camera marker remains visible after a capture or camera move, in milliseconds. */
export const AGENT_EYE_GIZMO_TIMEOUT_MS = 5000;

/** Why an attach was refused — the same vocabulary `_refuseIfCameraOwned` uses. */
export type AttachRefusal = 'no-controls' | 'fpv' | 'follow' | 'xr' | 'hidden' | 'no-viewer';

export interface AttachResult {
  attached: boolean;
  refused?: AttachRefusal;
}

export class AgentEyePlugin implements RVViewerPlugin {
  readonly id = 'agent-eye';
  readonly core = true;

  private _viewer: RVViewer | null = null;
  private _eye: AgentEye | null = null;
  private _gizmo: AgentEyeGizmo | null = null;
  private _source: AgentEyeFollowSource | null = null;
  private _showAgentEye = true;
  private _gizmoTimer: ReturnType<typeof setTimeout> | null = null;
  private _offs: Array<() => void> = [];
  private _channels: EyeChannels | null = null;

  /** The agent's camera body. Undefined before `init` (and in the embed viewer). */
  get eye(): AgentEye | undefined { return this._eye ?? undefined; }

  /**
   * The offscreen channel renderer, created on first use (plan-740 D-A15).
   *
   * The plugin owns it because the plugin owns the lifecycle it has to follow:
   * ONE persistent render target and one set of channel materials per body,
   * released on a model change and on teardown. Left to `McpObserveTools` the
   * target would outlive the model it was sized for, and nothing would ever
   * free it — a render target is not garbage-collected, it is a GPU
   * allocation. `McpObserveTools` reads this getter structurally (no import of
   * this class) precisely so the ownership can stay here.
   */
  get eyeChannels(): EyeChannels | undefined {
    if (!this._viewer) return undefined;
    this._channels ??= new EyeChannels(this._viewer as unknown as EyeChannelHost);
    return this._channels;
  }

  /** The cone. Exposed for tests and the double-click hit test. */
  get gizmo(): AgentEyeGizmo | undefined { return this._gizmo ?? undefined; }

  /** Whether the viewport currently rides the body. */
  get attached(): boolean { return this._eye?.attached === true; }

  init(viewer: RVViewer): void {
    this._viewer = viewer;
    this._showAgentEye = loadVisualSettings().showAgentEye !== false;

    this._eye = new AgentEye({
      getViewportState: () => this._viewportPose(viewer),
      modelKey: () => deriveModelKey(viewer.currentModelUrl),
    });

    this._gizmo = new AgentEyeGizmo();
    this._gizmo.setShow(false);
    viewer.scene.add(this._gizmo.group);

    this._offs.push(this._eye.onChange((s) => this._syncGizmo(s)));
    // Captures may reuse an unchanged pose. Listen to capture sequence changes,
    // not history length (which stops growing when the ring buffer is full).
    let lastCapture = getAgentEyeLatestSeq();
    this._offs.push(subscribeAgentEye(() => {
      const seq = getAgentEyeLatestSeq();
      if (seq > lastCapture) this._showGizmoTemporarily();
      lastCapture = seq;
    }));

    // (a) The human takes the wheel. Third `'start'` listener on these controls
    // (rv-viewer.ts sets `_isOrbiting`, GenericTooltipController closes its
    // tooltip); order is irrelevant because detaching fires no controls event.
    const controls = viewer.controls as unknown as {
      addEventListener?: (t: string, f: () => void) => void;
      removeEventListener?: (t: string, f: () => void) => void;
    } | undefined;
    if (controls?.addEventListener) {
      const onStart = (): void => { if (this.attached) this.detach(); };
      controls.addEventListener('start', onStart);
      this._offs.push(() => controls.removeEventListener?.('start', onStart));
    }

    // (c) FPV / XR take the camera over entirely.
    this._offs.push(viewer.on('fpv-enter', () => { if (this.attached) this.detach(); }));
    this._offs.push(viewer.on('xr-session-start', () => { if (this.attached) this.detach(); }));

    // Double-click attach, capture phase so it lands BEFORE the viewer's own
    // focus handler (rv-viewer.ts `_bindCanvasEvents`).
    const canvas = viewer.renderer?.domElement as HTMLCanvasElement | undefined;
    if (canvas) {
      const onDblClick = (e: MouseEvent): void => this._onDoubleClick(e, canvas);
      canvas.addEventListener('dblclick', onDblClick, { capture: true });
      this._offs.push(() => canvas.removeEventListener('dblclick', onDblClick, { capture: true }));
    }
  }

  /** A new model gets its own body: the old one is dropped, a saved pose adopted. */
  onModelLoaded(_result: LoadResult, _viewer: RVViewer): void {
    // A new model means new geometry behind every cached flat mesh and a
    // target sized for the old frame: release, do not reuse (D-A15).
    this._releaseChannels();
    if (!this._eye) return;
    if (this.attached) this.detach();
    this._eye.reset();
    // Load, do not spawn: a model the agent has never looked at stays bodiless
    // until its first web_camera_* call (§2.6).
    this._eye.loadPersisted();
    this._syncGizmo(this._eye.state);
  }

  onModelCleared(_viewer: RVViewer): void {
    this._releaseChannels();
    if (!this._eye) return;
    if (this.attached) this.detach();
    this._eye.reset();
    this._syncGizmo(this._eye.state);
  }

  dispose(): void {
    if (this.attached) this.detach();
    this._hideGizmo();
    for (const off of this._offs) {
      try { off(); } catch { /* a faulty unsubscribe must not block the rest */ }
    }
    this._offs = [];
    this._releaseChannels();
    this._gizmo?.dispose();
    this._gizmo = null;
    this._eye = null;
    this._viewer = null;
  }

  /** Free the render target and channel materials, if any were created. */
  private _releaseChannels(): void {
    this._channels?.dispose();
    this._channels = null;
  }

  // ─── Settings ─────────────────────────────────────────────────────

  /** Settings ▸ Visual ▸ "Show AI eye". Hiding also disables the attach gesture. */
  setShowAgentEye(show: boolean): void {
    this._showAgentEye = show;
    this._gizmo?.setShow(show && this._gizmoTimer !== null);
    if (!show && this.attached) this.detach();
    this._viewer?.markRenderDirty();
  }

  get showAgentEye(): boolean { return this._showAgentEye; }

  // ─── Attach / detach ──────────────────────────────────────────────

  /**
   * Ride the agent's body. Refused whenever something else already owns the
   * camera — FPV, another follow/sit-on, XR — or when there are no orbit
   * controls at all (kiosk), because then nothing could ever detach again.
   */
  attach(): AttachResult {
    const v = this._viewer;
    const eye = this._eye;
    if (!v || !eye) return { attached: false, refused: 'no-viewer' };
    if (!v.controls) return { attached: false, refused: 'no-controls' };
    if (!this._showAgentEye) return { attached: false, refused: 'hidden' };
    if (v.getPlugin<{ id: string; isActive?: boolean }>('fpv')?.isActive) return { attached: false, refused: 'fpv' };
    if (v.cameraFollowMode && v.cameraFollowMode !== 'off') return { attached: false, refused: 'follow' };
    const xr = (v.renderer as unknown as { xr?: { isPresenting?: boolean } }).xr;
    if (xr?.isPresenting) return { attached: false, refused: 'xr' };

    eye.ensure();
    // The callback closes D-A6(b): `animateCameraTo` ends this follow from
    // INSIDE the CameraManager (bookmark, preset, fitToNodes, focus
    // double-click) and no controls event announces that, so without it the
    // cone would stay hidden and `attached` would lie.
    this._source = new AgentEyeFollowSource(eye, () => this._onFollowStopped());
    v.startCameraFollow(this._source, 'agent-eye');
    eye.attached = true;
    return { attached: true };
  }

  /** Let go. No restore flight — the viewport stays exactly where it is. */
  detach(): void {
    const v = this._viewer;
    const eye = this._eye;
    if (!eye) return;
    const source = this._source;
    // Clear our own flags FIRST: stopCameraFollow calls back into
    // `_onFollowStopped`, which must find nothing left to do.
    this._source = null;
    eye.attached = false;
    if (v && source && v.cameraFollowSource === source) v.stopCameraFollow(false);
  }

  /** The follow ended somewhere else — catch up rather than fight it. */
  private _onFollowStopped(): void {
    this._source = null;
    if (this._eye) this._eye.attached = false;
  }

  // ─── Internals ────────────────────────────────────────────────────

  private _onDoubleClick(e: MouseEvent, canvas: HTMLCanvasElement): void {
    const v = this._viewer;
    const gizmo = this._gizmo;
    if (!v || !gizmo || !this._showAgentEye) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const box = gizmo.screenRect(v.camera, canvas);
    const hit = !!box
      && x >= box.x - ATTACH_MAGNET_PX && x <= box.x + box.width + ATTACH_MAGNET_PX
      && y >= box.y - ATTACH_MAGNET_PX && y <= box.y + box.height + ATTACH_MAGNET_PX;

    if (hit) {
      // Stop immediately: the viewer's own dblclick would otherwise fly the
      // camera to whatever mesh happens to sit behind the cone.
      this.attach();
      e.stopImmediatePropagation();
      return;
    }
    // Not the cone. If we are riding the body, let go FIRST so the focus flight
    // that follows is not fought by the follow tick (S2) — and let the event
    // continue to the normal focus handler.
    if (this.attached) this.detach();
  }

  private _syncGizmo(s: AgentEyeState): void {
    const eye = this._eye;
    const gizmo = this._gizmo;
    if (!eye || !gizmo) return;
    gizmo.setAttached(s.attached);
    if (!eye.exists) {
      this._hideGizmo();
      return;
    }
    gizmo.update(s.pose, (depth, out) => eye.frustumCornersFor(depth, out));
    this._showGizmoTemporarily();
  }

  private _showGizmoTemporarily(): void {
    if (!this._eye?.exists || !this._gizmo) return;
    if (this._gizmoTimer !== null) clearTimeout(this._gizmoTimer);
    this._gizmo.setShow(this._showAgentEye);
    this._gizmoTimer = setTimeout(() => this._hideGizmo(), AGENT_EYE_GIZMO_TIMEOUT_MS);
    this._viewer?.markRenderDirty();
  }

  private _hideGizmo(): void {
    if (this._gizmoTimer !== null) clearTimeout(this._gizmoTimer);
    this._gizmoTimer = null;
    this._gizmo?.setShow(false);
    this._viewer?.markRenderDirty();
  }

  private _viewportPose(viewer: RVViewer): ViewportPoseSnapshot {
    const st = viewer.getCameraState();
    return {
      position: [st.position.x, st.position.y, st.position.z],
      target: [st.target.x, st.target.y, st.target.z],
      fov: viewer.fov,
      projection: viewer.projection === 'orthographic' ? 'orthographic' : 'perspective',
    };
  }
}
