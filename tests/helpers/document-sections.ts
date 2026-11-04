// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * document-sections — the retired section projections, as TEST helpers
 * (plan-744 Phase 1).
 *
 * `sceneDocumentsOf()` and `assetDocumentsOf()` used to live in
 * `src/core/project/rv-project-documents.ts` and were deleted with their
 * production call sites: a projection over a path heuristic answers "no
 * scenes" for a browser project, whose document paths are bare ids, so every
 * live lookup now asks the real question instead (id, or a path predicate).
 *
 * They are kept HERE, verbatim, because a characterization test is allowed to
 * speak the old vocabulary — `assetDocumentsOf(project, 'models')` is a
 * perfectly good way for a test to say "the rows filed under `models/`", and
 * rewriting thirty assertions into inline filters would obscure what each one
 * is actually pinning.
 *
 * They are NOT a back door. `tests/listing-removal-guard.test.ts` pins that
 * nothing under `src/` imports them, and the only thing that changed about
 * their behaviour is the input: nothing stamps `section` any more (plan-744
 * Phase 2), so a browser scene row now falls to the path branch of
 * `sectionOfDocument` and reads as `library`. A test that breaks on that is
 * telling the truth about the stamp removal, not about this file.
 */

import {
  documentsInSection,
  type DocumentSection,
} from '../../src/core/project/rv-project-documents';
import type {
  RvDocumentEntry,
  RvProject,
} from '../../src/core/project/rv-project-types';

/** The documents whose PATH files them under `scenes/` (or `*.scene.glb`). */
export function sceneDocumentsOf(
  project: RvProject | null | undefined,
): RvDocumentEntry[] {
  return documentsInSection(project, 'scenes');
}

/** The documents whose PATH files them under `models/` or anywhere else. */
export function assetDocumentsOf(
  project: RvProject | null | undefined,
  section: Exclude<DocumentSection, 'scenes'>,
): RvDocumentEntry[] {
  return documentsInSection(project, section);
}
