// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-follow-policy — "Follow agent" camera feedback for MCP node writes (plan-520).
 *
 * When an AI agent writes to a node over MCP (component field, transform,
 * mechanism, drive jog), the camera flies to that node — but only while the
 * user has not used the viewport for {@link FOLLOW_IDLE_MS}, only when the
 * target is offscreen, small or clearly off-center, never twice to the same
 * target in an uninterrupted agent series (any viewport input by the user in
 * between re-arms the target) and not within {@link FOLLOW_COOLDOWN_MS} of the
 * last flight.
 * The user always wins: a gesture cancels the flight (tag
 * {@link FOLLOW_AGENT_CAMERA_TAG}, see rv-user-activity.ts), and while the user
 * is active the caller keeps its pre-plan-520 behaviour (`'fallback'`).
 *
 * Runs once per MCP call — no per-frame work. The projection uses module-level
 * scratch vectors. Never throws into the tool call (the caller wraps it too).
 */

import { Box3, Vector3 } from 'three';
import type { Camera, Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import { computeSubtreeAABB } from '../../core/engine/rv-traverse-utils';
import { getFollowAgent } from '../../core/hmi/follow-agent-store';
import { FOLLOW_AGENT_CAMERA_TAG } from '../../core/rv-user-activity';

/** Projected screen rectangle of a box, in NDC ([-1,1] = the viewport). */
export interface ScreenRect { cx: number; cy: number; w: number; h: number; behind: boolean }

/** `fly` = start a follow flight; `none` = follow owns this call, stay put; `fallback` = the old frameIfHelpful. */
export type FollowDecision = 'fly' | 'none' | 'fallback';

export interface FollowInput {
  enabled: boolean;
  idle: boolean;
  hidden: boolean;
  xrPresenting: boolean;
  cameraFollowMode: 'off' | string;
  targetKey: string;
  lastTargetKey: string | null;
  now: number;
  lastFlightAt: number;
  rect: ScreenRect | null;
}

/** The user counts as idle after this long without viewport input (ms). */
export const FOLLOW_IDLE_MS = 3000;
/** No new follow flight within this long after the last one (ms). */
export const FOLLOW_COOLDOWN_MS = 1500;
/** Follow flight duration (s), easeInOut. */
export const FOLLOW_FLIGHT_S = 0.7;
/** A target is "small" when max(w,h) is below this (NDC units; the screen is 2 wide). */
export const SMALL_EXTENT = 0.25;
/** A target is "off-center" when its center is farther than this from the NDC origin. */
export const OFF_CENTER = 0.5;

/**
 * The pure follow decision (plan-520 §2.3, rules in this order):
 * 1. disabled or user active → fallback
 * 2. hidden tab, WebXR, camera follow/sit-on mode or no rect → none
 * 3. same target as last time → none (the caller clears `lastTargetKey` once
 *    the user has used the viewport since that verdict)
 * 4. cooldown → none
 * 5. offscreen / behind → fly
 * 6. small or off-center → fly
 * 7. otherwise (well visible) → none
 */
export function decideFollow(i: FollowInput): FollowDecision {
  if (!i.enabled || !i.idle) return 'fallback';
  if (i.hidden || i.xrPresenting || i.cameraFollowMode !== 'off' || i.rect === null) return 'none';
  if (i.targetKey === i.lastTargetKey) return 'none';
  if (i.now - i.lastFlightAt < FOLLOW_COOLDOWN_MS) return 'none';
  const r = i.rect;
  if (r.behind || Math.abs(r.cx) > 1 || Math.abs(r.cy) > 1) return 'fly';
  if (Math.max(r.w, r.h) < SMALL_EXTENT || Math.hypot(r.cx, r.cy) > OFF_CENTER) return 'fly';
  return 'none';
}

// ─── Screen rect ────────────────────────────────────────────────────────

const _corners: Vector3[] = Array.from({ length: 8 }, () => new Vector3());
const _unionBox = new Box3();
const _nodeBox = new Box3();

/**
 * Project the 8 corners of `box` and return their NDC bounding rectangle.
 * `behind` = every corner lies behind the camera (or beyond far), z > 1.
 * Returns null for an empty box.
 */
export function computeScreenRect(camera: Camera, box: Box3): ScreenRect | null {
  if (box.isEmpty()) return null;
  camera.updateMatrixWorld();
  const { min, max } = box;
  _corners[0].set(min.x, min.y, min.z);
  _corners[1].set(max.x, min.y, min.z);
  _corners[2].set(min.x, max.y, min.z);
  _corners[3].set(max.x, max.y, min.z);
  _corners[4].set(min.x, min.y, max.z);
  _corners[5].set(max.x, min.y, max.z);
  _corners[6].set(min.x, max.y, max.z);
  _corners[7].set(max.x, max.y, max.z);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let behind = true;
  for (let k = 0; k < 8; k++) {
    const p = _corners[k].project(camera);
    if (p.z <= 1) behind = false;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY, behind };
}

// ─── Follow state (module-wide, like frameIfHelpful's throttle) ─────────

let lastTargetKey: string | null = null;
/** `UserActivity.inputEpoch` when `lastTargetKey` was stored; a different epoch voids the key. */
let lastTargetEpoch = 0;
let lastFlightAt = -Infinity;
let clock: () => number = () => Date.now();

/** Test hook: reset the follow memory and inject a clock for the cooldown. */
export function _resetFollowForTest(testClock?: () => number): void {
  lastTargetKey = null;
  lastTargetEpoch = 0;
  lastFlightAt = -Infinity;
  clock = testClock ?? (() => Date.now());
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function isXrPresenting(viewer: RVViewer): boolean {
  const xr = (viewer.renderer as unknown as { xr?: { isPresenting?: boolean } } | undefined)?.xr;
  return !!xr?.isPresenting;
}

/**
 * Decide and — on `fly` — start the follow flight to `paths` (already filtered
 * to resolvable registry paths by the caller, but re-resolved here). Returns
 * the decision so the caller can skip the old `frameIfHelpful` unless it is
 * `'fallback'`. `'fallback'` also for an empty target list (nothing to follow).
 */
export function followAgent(viewer: RVViewer, paths: string[]): FollowDecision {
  try {
    const nodes: Object3D[] = [];
    for (const p of paths) {
      const n = viewer.registry?.getNode(p);
      if (n) nodes.push(n);
    }
    if (nodes.length === 0) return 'fallback';

    const enabled = getFollowAgent();
    const activity = viewer.userActivity as RVViewer['userActivity'] | undefined;
    const idle = activity ? activity.isIdle(FOLLOW_IDLE_MS) : false;
    const targetKey = [...paths].sort().join('|');
    const now = clock();
    // The same-target guard only covers an uninterrupted agent series: once
    // the user has used the viewport since the last verdict, the target is
    // re-armed (idle again → follow again, F2). The cooldown stays as is.
    const epoch = activity?.inputEpoch ?? 0;
    const effectiveLastKey = activity && activity.inputEpoch !== lastTargetEpoch ? null : lastTargetKey;
    const base = {
      enabled, idle,
      hidden: typeof document !== 'undefined' && document.hidden,
      xrPresenting: isXrPresenting(viewer),
      cameraFollowMode: viewer.cameraFollowMode ?? 'off',
      targetKey, lastTargetKey: effectiveLastKey, now, lastFlightAt,
    };
    // Rule 1 first: no bounds walk while the user is active or follow is off.
    if (!enabled || !idle) return decideFollow({ ...base, rect: null });

    _unionBox.makeEmpty();
    for (const n of nodes) {
      n.updateMatrixWorld(true);
      _unionBox.union(computeSubtreeAABB(n, _nodeBox).box);
    }
    const rect = computeScreenRect(viewer.camera, _unionBox);
    const input: FollowInput = { ...base, rect };
    const decision = decideFollow(input);

    // Remember the target for every real follow verdict (fly, and "well
    // visible" rule 7) so A→A never flies and A→B→A does. A guard verdict
    // (hidden, XR, follow mode, no bounds) or the cooldown is not a verdict
    // about this target — remembering it would block a later flight to it.
    const guarded = input.hidden || input.xrPresenting || input.cameraFollowMode !== 'off'
      || rect === null || targetKey === effectiveLastKey || now - lastFlightAt < FOLLOW_COOLDOWN_MS;
    if (decision === 'fly' || !guarded) {
      lastTargetKey = targetKey;
      lastTargetEpoch = epoch;
    }

    if (decision === 'fly') {
      lastFlightAt = now;
      viewer.fitToNodes(nodes, undefined, {
        duration: prefersReducedMotion() ? 0 : FOLLOW_FLIGHT_S,
        easing: 'easeInOut',
        tag: FOLLOW_AGENT_CAMERA_TAG,
      });
    }
    return decision;
  } catch {
    return 'fallback';
  }
}
