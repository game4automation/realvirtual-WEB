// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Arena sink — the narrow seam between engine-level `.visible` / layer writers
 * and the editor's BatchedMesh arenas (plan-766 Phase 2, §2.4.2 / §2.4.5).
 *
 * The editor renders its meshes through `EditorArenaManager` arenas while the
 * source meshes stay in the tree with `layers.mask = 0`. Writers that know
 * nothing about the editor still have to tell the arenas two things:
 *
 *   - `bumpVisibility()` — a `.visible` changed somewhere WITHOUT an op (group
 *     registry, auto-filter, isolate); the next frame recomputes every
 *     instance's effective visibility.
 *   - `enterCapture()` / `leaveCapture()` — a render path needs the SOURCE
 *     meshes on their real layers (thumbnail clone, agent-eye capture, the
 *     wireframe view, a group/filter isolate). Refcounted by the sink.
 *
 * The sink is found through the SCENE a node lives in: the manager registers
 * itself for its scene while it is built ({@link setSceneArenaSink}), and a
 * writer resolves it with {@link arenaSinkOf}. No manager registered = every
 * call here is a null check, so runtime / planner / embed behaviour is
 * bit-identical to the pre-arena code (the manager is editor-only).
 */

import type { Object3D } from 'three';

/** What an engine-level writer may ask of the editor arenas. */
export interface ArenaVisibilitySink {
  /** A `.visible` changed without an op — recompute instance visibility next frame. */
  bumpVisibility(): void;
  /** Refcounted: source meshes back on their layers, arenas masked out. */
  enterCapture(): void;
  /** Counterpart of {@link enterCapture}. */
  leaveCapture(): void;
}

const sinks = new WeakMap<Object3D, ArenaVisibilitySink>();

/** Register (or clear with `null`) the arena sink for a scene root. */
export function setSceneArenaSink(scene: Object3D, sink: ArenaVisibilitySink | null): void {
  if (sink) sinks.set(scene, sink);
  else sinks.delete(scene);
}

/** The sink registered for `scene` itself (no ancestor walk). */
export function sceneArenaSink(scene: Object3D | null | undefined): ArenaVisibilitySink | null {
  return scene ? sinks.get(scene) ?? null : null;
}

/**
 * The sink of the scene `node` lives in — walks to the top-most ancestor.
 * `null` for a detached node or a scene without editor arenas. O(depth).
 */
export function arenaSinkOf(node: Object3D | null | undefined): ArenaVisibilitySink | null {
  if (!node) return null;
  let top: Object3D = node;
  while (top.parent) top = top.parent;
  return sinks.get(top) ?? null;
}

/**
 * Holds at most ONE capture on one sink for a long-lived state (an isolate).
 *
 * `sync(sink, want)` enters when `want` turns true and leaves when it turns
 * false — always on the sink it ENTERED, so a manager rebuilt in between
 * never receives an unpaired `leaveCapture()`.
 */
export class ArenaCaptureLatch {
  private _held: ArenaVisibilitySink | null = null;

  /** True while a capture is held. */
  get held(): boolean { return this._held !== null; }

  sync(sink: ArenaVisibilitySink | null, want: boolean): void {
    if (want) {
      if (this._held === sink) return;
      this.release();
      if (sink) {
        sink.enterCapture();
        this._held = sink;
      }
      return;
    }
    this.release();
  }

  /** Leave the held capture (if any). */
  release(): void {
    const held = this._held;
    this._held = null;
    held?.leaveCapture();
  }
}
