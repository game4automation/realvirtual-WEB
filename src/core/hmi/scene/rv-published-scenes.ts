// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-published-scenes — catalogue of read-only "Example" scenes.
 *
 * Examples are curated demos (e.g. a planner layout). Unlike "My Scenes" they
 * are NOT stored in localStorage — opening one loads it transiently via
 * `SceneStore.openPublishedExample`, and "Add to My Scenes"
 * (`SceneStore.addPublishedToMyScenes`) materialises an editable copy the user
 * owns. The catalogue is a curated `scenes/index.json` (`[{ file, name, mode }]`).
 *
 * ## Where the bytes live
 *
 * They belong to the **DemoRealvirtual project**, which is BUNDLED: its scenes
 * are `public/scenes/`, so Vite serves them at `<BASE_URL>scenes/` in dev and
 * copies them to exactly that path in a build. One location, dev and deployed
 * alike — no dev-only mount and no base to record.
 *
 * ## Examples are GLBs (plan-413 phase 3)
 *
 * They used to be `.scene.json` op logs — the last corner of the product where
 * a scene was not a file. Since plan-397 every saved scene is a GLB, and an
 * Example is just a scene somebody else saved, so the catalogue now lists
 * `.glb` and the loader is the ordinary GLB path. The conversion itself is
 * `tests/bake-published-scenes.node.test.ts`, which ran the two op logs through
 * the very `materialise()` + `bakeIntoGlb()` pair a user's Save goes through.
 *
 * A `.scene.json` entry left in an older deploy's `index.json` is therefore
 * skipped — loudly (`console.warn`), because an Examples list that quietly
 * shrinks to nothing is the failure mode worth spending a log line on.
 */

import { normaliseDocumentLevel, type DocumentLevel } from '../../project/rv-document-classification';

/** A single example scene available in the "Examples" section. */
export interface PublishedSceneEntry {
  /** Filename inside the project's `scenes/` folder, e.g. "DemoPlanner.glb". */
  file: string;
  /** Token used in `?scene=published:<urlName>` — `file` without ".glb". */
  urlName: string;
  /** Display label shown in the Examples list. */
  label: string;
  /** Preferred workspace mode to switch to on open (e.g. "planner"). Optional. */
  mode?: string;
  /**
   * Classification level of the example, cached from its GLB (plan-413 §2.5).
   *
   * The bytes are the source of truth here as everywhere, but a bundled deploy
   * is the one place §2.5 says never to scan: it is read-only over HTTP, so its
   * catalogue cannot go stale against bytes nobody can modify, and reading the
   * level out of it would mean downloading every example to draw a list.
   * Absent means unclassified, exactly as it does in a manifest.
   */
  level?: DocumentLevel;
}

/** Fetchable URL of one example scene file. */
export function publishedSceneUrl(file: string): string {
  return `${deployBase()}scenes/${file}`;
}

/**
 * Manifest `path` for one example scene.
 *
 * Always deploy-relative (`scenes/<file>`), because `BundledBackend` resolves
 * it against the deploy root itself.
 */
export function publishedScenePath(file: string): string {
  return `scenes/${file}`;
}

function deployBase(): string {
  try {
    return (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  } catch {
    return '/';
  }
}

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

/** What a `?scene=published:<name>` deep link resolves to. */
export interface PublishedDeepLink {
  /** File to load, `<name>.glb` when the catalogue does not know the name. */
  file: string;
  label?: string;
  mode?: string;
  /**
   * The catalogue lists it, so it exists and no probe is needed. When false the
   * caller must establish existence itself before opening — and fall through to
   * the normal boot chain when it cannot.
   */
  catalogued: boolean;
}

/**
 * Resolve a `?scene=published:<name>` token against the Examples catalogue.
 *
 * Lives here rather than inline in the boot routine for two reasons: the boot
 * routine is not reachable from a test, and the rule itself — "the catalogue
 * decides, the filesystem is only consulted when it does not know" — is the
 * whole of the deep link's behaviour (plan-413 §2.6 point 5, test 9.10).
 */
export function resolvePublishedDeepLink(
  urlName: string,
  catalogue: readonly PublishedSceneEntry[],
): PublishedDeepLink {
  const entry = catalogue.find(e => e.urlName === urlName);
  if (entry) {
    return { file: entry.file, label: entry.label, mode: entry.mode, catalogued: true };
  }
  return { file: publishedFileFromUrlName(urlName), catalogued: false };
}

/**
 * Build a catalogue entry from a bare filename (glob fallback path) — label
 * defaults to the url name, no preferred mode.
 */
export function publishedEntryFromFile(file: string): PublishedSceneEntry {
  const urlName = urlNameFromFile(file);
  return { file, urlName, label: urlName };
}

/**
 * Parse a curated `scenes/index.json` payload into catalogue entries.
 * Defensive: ignores non-array input and any item without a valid `file`
 * ending in `.glb`. `name` becomes the label (falls back to the url
 * name); `mode` is carried through only when it is a non-empty string.
 *
 * A pre-plan-413 `.scene.json` entry is skipped with a warning naming the
 * reason — see the module docstring.
 */
export function parsePublishedIndex(raw: unknown): PublishedSceneEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PublishedSceneEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const file = rec.file;
    if (typeof file === 'string' && /\.scene\.json$/i.test(file)) {
      console.warn(
        `[published-scenes] '${file}' is a legacy JSON example and is not listed. `
        + 'Example scenes are GLBs since realvirtual WEB 6.3 — re-deploy to convert them.',
      );
      continue;
    }
    if (typeof file !== 'string' || !/\.glb$/i.test(file)) continue;
    const urlName = urlNameFromFile(file);
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const mode = typeof rec.mode === 'string' && rec.mode.trim() ? rec.mode.trim() : undefined;
    const level = normaliseDocumentLevel(rec.level);
    out.push({ file, urlName, label: name || urlName, mode, level });
  }
  return out;
}
