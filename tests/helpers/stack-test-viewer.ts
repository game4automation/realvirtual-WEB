// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * stack-test-viewer — the renderer-free isolate surface plan-703 §9.4 needs.
 *
 * The plan is explicit that the mock from `rv-asset-document.test.ts` is NOT
 * enough here: it stubs neither `groups`, nor `fitToNodes`, nor
 * `raycastManager.setIsolationGate`, and §9.4 checks all three. What it does
 * get right — a real `NodeRegistry` and a real `Scene`, no `WebGLRenderer` —
 * this keeps.
 *
 * `isolateNodes` / `exitIsolate` are MIRRORED here rather than imported:
 * `RVViewer` cannot be constructed without a renderer, and the two methods are
 * only 20 lines (`rv-viewer.ts:4438-4464`). The mirror is deliberately
 * line-for-line faithful in the four effects that matter —
 *
 *   1. take over any prior isolate first (the ONE-SLOT contract),
 *   2. force the roots visible and remember their prior visibility,
 *   3. `groups.setExternalIsolated(roots)` — dimming AND the pick gate,
 *   4. `fitToNodes(roots)` — the camera,
 *
 * — because a mock that got (1) or (3) wrong would let the stack pass while the
 * real viewer broke. The pick gate itself is the REAL one: the predicate below
 * is copied from where the viewer installs it (`rv-viewer.ts:3553`) and reads a
 * real `GroupRegistry`, so "the gate rejects a node outside the isolated
 * subtree" is a fact about production code, not about this file.
 */

import { Object3D, Scene } from 'three';
import { GroupRegistry } from '../../src/core/engine/rv-group-registry';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { RvDocument } from '../../src/core/ops/rv-document';
import type { RvExecutor } from '../../src/core/ops/rv-unified-executors';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import type { RvDraftFrameKey } from '../../src/core/ops/rv-document-drafts';
import type { RvStackDocument, RvStackViewer } from '../../src/core/ops/rv-document-stack';

export interface StackTestViewer extends RvStackViewer {
  scene: Scene;
  registry: NodeRegistry;
  groups: GroupRegistry;
  /** Roots handed to the last `fitToNodes`, or null when none happened yet. */
  lastFit: Object3D[] | null;
  /** How often `exitIsolate` did real work. */
  exitCount: number;
  /** True while an isolate is installed. */
  readonly isolateActive: boolean;
  /** The production pick gate, over this viewer's real GroupRegistry. */
  pickGate(node: Object3D): boolean;
}

export function createStackTestViewer(): StackTestViewer {
  const scene = new Scene();
  const registry = new NodeRegistry();
  const groups = new GroupRegistry();

  let priorVis: { node: Object3D; visible: boolean }[] = [];
  let active = false;

  const viewer: StackTestViewer = {
    scene,
    registry,
    groups,
    lastFit: null,
    exitCount: 0,
    get isolateActive() { return active; },

    isolateNodes(nodes: Object3D[]): void {
      if (nodes.length === 0) return;
      viewer.exitIsolate();       // the one-slot takeover
      priorVis = [];
      for (const n of nodes) {
        priorVis.push({ node: n, visible: n.visible });
        n.visible = true;
      }
      groups.setExternalIsolated(nodes);
      active = true;
      viewer.lastFit = [...nodes];
    },

    exitIsolate(): void {
      if (!active) return;
      groups.setExternalIsolated(null);
      for (const { node, visible } of priorVis) node.visible = visible;
      priorVis = [];
      active = false;
      viewer.exitCount++;
    },

    // Verbatim from rv-viewer.ts:3553 — the autoFilters half is omitted because
    // no auto filter exists in a bare test viewer, and omitting it can only make
    // the gate MORE permissive, never less.
    pickGate(node: Object3D): boolean {
      if (groups.isIsolateActive && !groups.isInIsolatedSubtree(node)) return false;
      return true;
    },
  };

  return viewer;
}

// ─── A document with no scene behind it ─────────────────────────────────

/** Every op it is handed is "applied". Records them so a test can look. */
export class RecordingExecutor implements RvExecutor {
  readonly forward: RvOp[] = [];
  readonly inverse: RvOp[] = [];
  /** Set to make the NEXT forward apply reject (transaction rollback tests). */
  failNextForward = false;

  async applyForward(op: RvOp): Promise<void> {
    if (this.failNextForward) {
      this.failNextForward = false;
      throw new Error('executor refused');
    }
    this.forward.push(op);
  }

  async applyInverse(op: RvOp): Promise<void> {
    this.inverse.push(op);
  }
}

/**
 * A stack frame's document, without the asset lineage.
 *
 * Satisfies `RvStackDocument` structurally — including the optional
 * `setDraftFrame`, so the draft-slot hand-over can be asserted without an
 * IndexedDB round trip.
 */
export class TestStackDocument implements RvStackDocument {
  readonly document: RvDocument;
  readonly executor = new RecordingExecutor();
  draftFrame: RvDraftFrameKey | null = null;
  disposed = false;

  constructor(readonly id: string, name = id) {
    this.document = new RvDocument({
      id, name, mode: 'asset', executor: this.executor,
    });
  }

  setDraftFrame(frame: RvDraftFrameKey | null): void { this.draftFrame = frame; }

  dispose(): void {
    this.disposed = true;
    this.document.dispose();
  }
}

/** A named node under `parent`, so isolate roots are real scene objects. */
export function nodeIn(parent: Object3D, name: string): Object3D {
  const node = new Object3D();
  node.name = name;
  parent.add(node);
  return node;
}
