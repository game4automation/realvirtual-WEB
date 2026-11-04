// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-planning-write — store a document's planning scenarios in its own bytes
 * (plan-630 §2.8).
 *
 * A structural copy of `writeDocumentInfo` (`rv-document-info-write`), and deliberately so:
 * the `PlanningScenarios` block sits beside `DocumentInfo` in the same scene extras, so it is
 * written by the same machinery — **the bytes first, the cache second**, the fast path
 * through `bakeIntoGlb` (JSON chunk patched, BIN tail byte-identical) and the mandatory
 * compare-and-swap on the revision just read.
 *
 * Only an explicit save calls this (the overlay's Save, later `web_scenario_save`): there is
 * no autosave, because a document is a file in the project and its git diff should be a
 * decision.
 */

import { bakeIntoGlb } from '../hmi/scene/rv-scene-glb-bake';
import { materialise } from '../hmi/scene/rv-scene-edits';
import { isEmptyScenarioBlock, type PlanningScenarioBlock } from '../planning/rv-planning-scenario';
import type { ProjectBackend } from './backends/project-backend';
import type { RvDocumentEntry } from './rv-project-types';
import type { SceneRevision } from './rv-scene-record';

/** A resolver that locates nothing — there are no node edits to place. */
const NO_NODES = { locate: () => null };

export interface DocumentPlanningWriteResult {
  /** What the file now says. `null` when the block was removed (nothing but the empty default). */
  planningScenarios: PlanningScenarioBlock | null;
  /** Revision of the stored body after the write. */
  revision: SceneRevision;
}

/**
 * Read a document's bytes, replace its `PlanningScenarios` block, write them back.
 *
 * `block === null` — or a block holding only the empty default scenario — removes it.
 * Throws rather than reporting failure in-band: a read-only project, an unreadable body,
 * or a revision somebody else replaced in the meantime.
 */
export async function writeDocumentPlanning(
  backend: ProjectBackend,
  doc: RvDocumentEntry,
  block: PlanningScenarioBlock | null,
): Promise<DocumentPlanningWriteResult> {
  if (!backend.writable) throw new Error('This project is read-only.');
  const next = block && !isEmptyScenarioBlock(block) ? block : null;

  const record = await backend.readDocument({ path: doc.path, id: doc.id });
  if (!record) throw new Error(`"${doc.name}" could not be read from this project.`);

  const baked = await bakeIntoGlb(record.bytes, materialise([]), NO_NODES, {
    planningScenarios: next,
    self: { assetId: doc.id, path: doc.path },
  });
  const meta: RvDocumentEntry = { ...doc, extrasScan: 2 };
  const { revision } = await backend.writeDocument(
    { path: doc.path, id: doc.id, meta },
    baked.glb,
    // The revision of what was just read: whoever replaced the file in the meantime saved
    // something of their own, and overwriting it silently is the lost update this refuses.
    { expectedRevision: record.revision },
  );
  return { planningScenarios: next, revision };
}
