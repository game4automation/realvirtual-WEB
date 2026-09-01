// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * assertManifestResolves — the release gate, one channel at a time (plan-731
 * Phase 4, F6).
 *
 * ## What it replaces
 *
 * `demo-manifest-invariants.node.test.ts` already asserts "every document names
 * a file that is actually in `public/`". That is a statement about the SOURCE
 * TREE, and the source tree is not what anybody downloads. Between it and a
 * visitor sit four staging paths, each of which copies, filters and prunes —
 * and none of which checked that what came out the other end still resolves.
 *
 * This helper lifts the same assertion onto a STAGED ROOT, so each channel can
 * make it about its own output. It is deliberately a shared helper rather than
 * four similar blocks: four spellings of one rule is how three of them end up
 * checking slightly less than the strictest.
 *
 * ## What it asserts
 *
 * 1. `project.json` is there and is a valid v2 manifest. A channel that ships
 *    no manifest ships a bundle whose gate opens nothing (plan-726 F11b).
 * 2. Every `documents[]` row names a file that exists under the root. A row
 *    without bytes is a 404 that only the visitor ever sees.
 * 3. No `devOnly` row survived. That is the whole point of plan-731 2k: the
 *    fixture is marked in the manifest precisely so this can be checked.
 * 4. The start document is declared and is one of the rows. A manifest whose
 *    `settings.defaultModel` matches nothing boots to an empty viewport.
 * 5. A declared `settingsPath` names a file that is there too (F5) — a sidecar
 *    that did not travel is a demo that comes up unconfigured.
 *
 * ## Signature
 *
 * THROWS on violation, with a message naming the root, the rule and the row —
 * a gate whose failure does not say which channel and which document costs more
 * time than it saves. RETURNS the checked rows on success, so a caller can make
 * further channel-specific assertions over exactly what the gate saw.
 *
 * Paths are resolved relative to the root passed in; a row path is never
 * allowed to escape it.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { isValidProjectV2, type RvDocumentEntry } from '../../src/core/project/rv-project-types';
import { documentsOf, findStartDocument } from '../../src/core/project/rv-project-documents';

/** What the gate saw, for channel-specific assertions on top of it. */
export interface ResolvedManifest {
  /** The parsed manifest. */
  project: ReturnType<typeof JSON.parse>;
  /** Every checked row, in manifest order. */
  documents: RvDocumentEntry[];
  /** The start document, always present on success. */
  start: RvDocumentEntry;
  /** Sidecar paths that were declared and found. */
  sidecars: string[];
}

function fail(rootDir: string, message: string): never {
  throw new Error(`[manifest gate] ${rootDir}: ${message}`);
}

/** Absolute path of a root-relative row path, or null when it escapes the root. */
function within(rootDir: string, relPath: string): string | null {
  const root = resolve(rootDir);
  const full = resolve(root, relPath.replace(/\\/g, '/'));
  return full === root || full.startsWith(root + sep) ? full : null;
}

function fileExists(full: string): boolean {
  try { return existsSync(full) && statSync(full).isFile(); } catch { return false; }
}

/**
 * Assert that the staged root at `rootDir` ships a manifest that fully resolves.
 *
 * @param rootDir the STAGED output of one channel — a `dist/`, a payload folder,
 *   a delivered workspace. Not a source tree: the point is what shipped.
 */
export function assertManifestResolves(rootDir: string): ResolvedManifest {
  const manifestPath = join(rootDir, 'project.json');
  if (!fileExists(manifestPath)) {
    fail(rootDir, 'no project.json — this channel ships a bundle whose gate opens nothing.');
  }

  let project: unknown;
  try {
    project = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (ex) {
    fail(rootDir, `project.json is not valid JSON: ${(ex as Error)?.message ?? ex}`);
  }

  if (!isValidProjectV2(project)) {
    fail(rootDir, 'project.json is not a valid v2 manifest (isValidProjectV2 refused it).');
  }

  const documents = documentsOf(project as never);
  if (documents.length === 0) {
    fail(rootDir, 'project.json declares no documents — refusing an empty delivery.');
  }

  const sidecars: string[] = [];
  for (const doc of documents) {
    if (doc.devOnly === true) {
      fail(rootDir, `dev-only document "${doc.path}" reached this channel — the staging `
        + 'prune did not run, or did not run on the manifest.');
    }
    const full = within(rootDir, doc.path);
    if (!full) fail(rootDir, `document "${doc.path}" escapes the delivery root.`);
    if (!fileExists(full)) {
      fail(rootDir, `document "${doc.path}" names a file that is not here — a 404 only the `
        + 'visitor would ever meet.');
    }
    const declared = typeof doc.settingsPath === 'string' ? doc.settingsPath : '';
    if (declared) {
      const sidecar = within(rootDir, declared);
      if (!sidecar) fail(rootDir, `settingsPath "${declared}" escapes the delivery root.`);
      if (!fileExists(sidecar)) {
        fail(rootDir, `settingsPath "${declared}" (document "${doc.path}") did not travel — `
          + 'the demo would come up unconfigured.');
      }
      sidecars.push(declared);
    }
  }

  const declaredStart = (project as { settings?: { defaultModel?: unknown } }).settings?.defaultModel;
  const start = findStartDocument(
    project as never,
    typeof declaredStart === 'string' ? declaredStart : undefined,
  );
  if (!start) {
    fail(rootDir, 'no start document resolves — the deploy would boot to an empty viewport.');
  }
  if (!documents.some(d => d.id === start.id)) {
    fail(rootDir, `the start document "${start.id}" is not one of the shipped rows.`);
  }

  return { project, documents, start, sidecars };
}
