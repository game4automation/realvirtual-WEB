// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-published-scenes — the `published:<urlName>` ALIAS (plan-731 Phase 2).
 *
 * ## What this module used to be, and why it is not that any more
 *
 * It used to own a second catalogue: a curated `scenes/index.json` listing
 * read-only "Example" scenes under `public/scenes/`, each addressed by a
 * `published:<urlName>` token. That token was a **second document identity
 * space** standing beside `stableDocumentId(path)` — with seven independent
 * consumers, among them a hard-coded literal in the Welcome modal's planner
 * button, i.e. in the first click of a community visitor.
 *
 * Since plan-726 the demo is a PROJECT and `public/project.json`'s `documents[]`
 * is the one catalogue. plan-731 finished the job: the `scenes/` folder and its
 * `index.json` are gone, and every example is an ordinary document row.
 *
 * ## What is left: an alias, and only an alias
 *
 * Old links do not break. `?scene=published:<urlName>` still resolves — through
 * {@link resolvePublishedAlias}, which maps the token onto the document whose
 * path carries that basename and hands back its **document id**. From that point
 * on the boot follows the ordinary `openDocument()` path, exactly as `?doc=`
 * does, and the address bar is normalised to `?doc=`.
 *
 * The mapping is DERIVED, never stored. That distinguishes it from
 * `rv-doc-alias`, whose `scn_ → doc_` aliases are localStorage records of a
 * migration that happened on one machine: a `published:` link is a link a
 * stranger clicks in a fresh browser, so its resolution has to be a pure
 * function of the token and the manifest, and nothing else.
 */



/** Prefix of the legacy example identity space. */
export const PUBLISHED_ID_PREFIX = 'published:';

/** The one extension an example may have since plan-413 phase 3. */
export const PUBLISHED_SCENE_EXT = '.glb';

/** Strip the `.glb` suffix to get the `?scene=published:<name>` token. */
export function urlNameFromFile(file: string): string {
  return file.replace(/\.glb$/i, '');
}

/** Filename of an example addressed by its `?scene=published:<name>` token. */
export function publishedFileFromUrlName(urlName: string): string {
  return `${urlName}${PUBLISHED_SCENE_EXT}`;
}

/**
 * The `urlName` a document answers to under the legacy `published:` space.
 *
 * The basename of its path without the extension — the same string
 * `scenes/index.json` used to carry as `file` minus `.glb`, which is what makes
 * an old link and a current row meet.
 */
export function publishedUrlNameOf(doc: { path?: string }): string {
  const path = typeof doc?.path === 'string' ? doc.path : '';
  const base = path.split(/[\\/]/).pop() ?? '';
  return urlNameFromFile(base);
}

/**
 * The `published:<urlName>` token a document would have been addressed by.
 *
 * Only ever used to RECOGNISE an old address, never to mint a new one — every
 * link this build writes carries `?doc=<id>` (plan-731 2c, the compose side).
 */
export function publishedTokenOf(doc: { path?: string }): string {
  return PUBLISHED_ID_PREFIX + publishedUrlNameOf(doc);
}

/**
 * The `urlName` inside a `?scene=published:<name>` value, or null.
 *
 * Decodes the token so a name with a space or a slash in it survives the URL,
 * exactly as the boot used to do inline.
 */
export function parsePublishedToken(scene: string | null | undefined): string | null {
  if (typeof scene !== 'string' || !scene.startsWith(PUBLISHED_ID_PREFIX)) return null;
  const raw = scene.slice(PUBLISHED_ID_PREFIX.length);
  if (raw === '') return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    // A malformed escape is still a name — better a literal match attempt than
    // a thrown boot.
    return raw;
  }
}

/**
 * Resolve a legacy `published:<urlName>` token against a project's documents.
 *
 * Returns the document row, or null when nothing in the manifest answers to that
 * name. Null is the honest answer and the caller falls through to its normal
 * boot chain — the same outcome the catalogue's "not catalogued" branch had.
 *
 * Matching is on the path BASENAME, case-insensitively, because that is the
 * string the old catalogue derived `urlName` from. A row whose path is
 * `scenes/DemoPlanner.glb` and one whose path is `DemoPlanner.glb` therefore
 * both answer to `published:DemoPlanner` — which is exactly what has to hold
 * across plan-731's move of the fixture out of `scenes/`.
 */
export function resolvePublishedAlias<T extends { path?: string }>(
  urlName: string | null | undefined,
  documents: readonly T[],
): T | null {
  if (!urlName) return null;
  const wanted = urlName.toLowerCase();
  for (const doc of documents) {
    if (!doc || typeof doc !== 'object') continue;
    if (publishedUrlNameOf(doc).toLowerCase() === wanted) return doc;
  }
  return null;
}

/**
 * Resolve a whole `?scene=` value when — and only when — it is a `published:`
 * token. Returns null for every other shape, so a caller can chain it into an
 * `if` without pre-parsing.
 */
export function resolvePublishedSceneParam<T extends { path?: string }>(
  scene: string | null | undefined,
  documents: readonly T[],
): T | null {
  return resolvePublishedAlias(parsePublishedToken(scene), documents);
}
