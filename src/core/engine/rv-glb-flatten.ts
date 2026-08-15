// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-glb-flatten — the flat export, and the way back out of it (plan-397
 * phase 8, F8).
 *
 * ## Most of this is already done by the time it is asked for
 *
 * Composition resolves eagerly: by the time a scene is on screen, every
 * referenced subtree is already grafted under its reference node. So "embed all
 * references" is not an assembly step — the tree IS assembled. What a flat
 * export has to do is smaller and more precise: **say so in the file**, so that
 * loading the result does not fetch and graft a second copy on top of the one
 * that is already there.
 *
 * That is exactly what `AssetReference.embedded` means, and
 * `isUnresolvedReferenceNode()` has honoured it since phase 3. Setting it turns
 * a reference from an instruction into a **provenance note**: `assetId` and
 * `sha256` stay, so the file still knows what it was built from and from which
 * version — F8's requirement, and the reason a flat file is not a dead end.
 *
 * ## Why it does not grow with the number of occurrences
 *
 * Ten occurrences of one assembly are ten clones sharing one `BufferGeometry`,
 * and `GLTFExporter` deduplicates that. Phase 0 measured it rather than assumed
 * it: ten occurrences came out at **1.02x** a single export, against a
 * control with distinct geometry at 9.97x. The plan's threshold — ten instances
 * under twice the single size — is therefore a regression guard, not a hope.
 * {@link glb-flatten-export.test.ts} keeps it honest.
 *
 * ## The way back
 *
 * {@link unflattenReferences} removes an embedded subtree and clears the flag,
 * leaving the reference to resolve normally again. It rests on the rv-ODT
 * invariant that a reference node **carries no subtree of its own** (§7d.8:
 * "its subtree lives in another asset"), so everything under it is the
 * embedded content. That is a documented property of the format, not an
 * assumption about a particular file.
 */

import type { Object3D } from 'three';
import {
  getAssetReference,
  setAssetReference,
  type AssetReference,
} from './rv-asset-reference';
import type { ComposedFrame } from './rv-glb-compose';

// ─── Provenance ─────────────────────────────────────────────────────────

/** What a flat file records about one embedded subtree. */
export interface EmbeddedOrigin {
  assetId: string;
  /** Content hash of the referenced file at the moment it was embedded. */
  sha256: string;
  /** Where it was resolved from, for a human reading the file. */
  url?: string;
}

export interface FlattenResult {
  /** One entry per reference node that was marked embedded. */
  embedded: EmbeddedOrigin[];
  /** Reference nodes that were already `embedded` and were left alone. */
  alreadyEmbedded: number;
}

/**
 * Mark every resolved reference in a composed tree as embedded.
 *
 * Operates on the live tree, immediately before it is handed to the exporter.
 * The frames carry the provenance — they are the only place that knows which
 * reference node resolved to which bytes.
 *
 * A reference that did **not** resolve is deliberately left untouched: marking
 * it embedded would claim its content is in the file when the file is exactly
 * what does not contain it.
 */
export function markReferencesEmbedded(frames: readonly ComposedFrame[]): FlattenResult {
  const embedded: EmbeddedOrigin[] = [];
  let alreadyEmbedded = 0;

  for (const frame of frames) {
    const existing = getAssetReference(frame.referenceNode);
    if (!existing) continue;
    if (existing.embedded === true) { alreadyEmbedded++; continue; }

    const next: AssetReference = {
      ...existing,
      // The hash of what was ACTUALLY embedded, not what the reference asked
      // for. When the asset had been updated since the reference was written,
      // those differ — and the file must record the version it contains.
      sha256: frame.sha256 || existing.sha256,
      embedded: true,
    };
    setAssetReference(frame.referenceNode, next);
    embedded.push({
      assetId: next.assetId,
      sha256: next.sha256 ?? '',
      url: frame.url,
    });
  }

  return { embedded, alreadyEmbedded };
}

/** Undo {@link markReferencesEmbedded} on a live tree, without touching children. */
export function unmarkReferencesEmbedded(frames: readonly ComposedFrame[]): number {
  let cleared = 0;
  for (const frame of frames) {
    const ref = getAssetReference(frame.referenceNode);
    if (!ref?.embedded) continue;
    const { embedded: _drop, ...rest } = ref;
    setAssetReference(frame.referenceNode, rest);
    cleared++;
  }
  return cleared;
}

// ─── The way back ───────────────────────────────────────────────────────

export interface UnflattenResult {
  /** Reference nodes turned back into unresolved references. */
  restored: EmbeddedOrigin[];
  /** Nodes removed from the tree in the process. */
  removedNodes: number;
}

/**
 * Turn embedded subtrees back into plain references.
 *
 * The inverse of the flat export, and what keeps a flat file from being a
 * one-way door: after this the tree is the referencing document again, ready
 * for composition to resolve it from the library.
 *
 * Nested embedded references are handled by not descending into a node once it
 * has been emptied — its children are gone, so there is nothing below to visit,
 * and the inner references went with them. That is correct rather than
 * convenient: they were the inner file's content, and the inner file is what
 * the outer reference will fetch again.
 */
export function unflattenReferences(root: Object3D): UnflattenResult {
  const restored: EmbeddedOrigin[] = [];
  let removedNodes = 0;

  const visit = (node: Object3D): void => {
    const ref = getAssetReference(node);
    if (ref?.embedded === true) {
      removedNodes += countSubtree(node) - 1;
      // `[...children]` — `remove()` splices the live array, and iterating it
      // while it shrinks would skip every other child.
      for (const child of [...node.children]) node.remove(child);
      const { embedded: _drop, ...rest } = ref;
      setAssetReference(node, rest);
      restored.push({ assetId: ref.assetId, sha256: ref.sha256 ?? '' });
      return;
    }
    for (const child of [...node.children]) visit(child);
  };
  visit(root);

  return { restored, removedNodes };
}

function countSubtree(node: Object3D): number {
  let n = 0;
  node.traverse(() => { n++; });
  return n;
}

// ─── Size preview (§3.3) ────────────────────────────────────────────────

export interface FlattenSizeEstimate {
  /** Size of the root file as it stands. */
  baseBytes: number;
  /** Sum over DISTINCT referenced assets — see below. */
  referencedBytes: number;
  /** `baseBytes + referencedBytes`. */
  totalBytes: number;
  /** How many reference occurrences the scene has. */
  occurrences: number;
  /** How many distinct files those occurrences come from. */
  distinctAssets: number;
}

/**
 * What a flat export would roughly weigh, without performing one.
 *
 * Summed over **distinct** assets rather than occurrences, and that is the
 * whole content of the estimate: ten occurrences of one assembly share one
 * `BufferGeometry`, the exporter deduplicates it, and Phase 0 measured the
 * result at 1.02x a single export. Counting occurrences would tell the user
 * their file is about to be ten times bigger than it will be — a preview that
 * is wrong in the direction that makes people not press the button.
 *
 * It is an estimate and says so: JSON overhead, textures shared with the root
 * and the exporter's own packing all move the real number a little.
 */
export function estimateFlattenedSize(
  baseBytes: number,
  frames: readonly ComposedFrame[],
): FlattenSizeEstimate {
  const bySource = new Map<string, number>();
  for (const frame of frames) {
    // Key on the FILE, not the occurrence — `sourceKey` is the content hash
    // where one exists, which is exactly the identity the exporter dedups on.
    if (!bySource.has(frame.sourceKey)) bySource.set(frame.sourceKey, frame.sizeBytes);
  }
  let referencedBytes = 0;
  for (const size of bySource.values()) referencedBytes += size;

  return {
    baseBytes,
    referencedBytes,
    totalBytes: baseBytes + referencedBytes,
    occurrences: frames.length,
    distinctAssets: bySource.size,
  };
}

/** Human-readable size, for the export dialog. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
