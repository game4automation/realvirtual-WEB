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
 */

/** A single example scene available in the "Examples" section. */
export interface PublishedSceneEntry {
  /** Filename inside the project's `scenes/` folder, e.g. "DemoPlanner.scene.json". */
  file: string;
  /** Token used in `?scene=published:<urlName>` — `file` without ".scene.json". */
  urlName: string;
  /** Display label shown in the Examples list. */
  label: string;
  /** Preferred workspace mode to switch to on open (e.g. "planner"). Optional. */
  mode?: string;
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

/** Strip the `.scene.json` suffix to get the `?scene=published:<name>` token. */
export function urlNameFromFile(file: string): string {
  return file.replace(/\.scene\.json$/i, '');
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
 * ending in `.scene.json`. `name` becomes the label (falls back to the url
 * name); `mode` is carried through only when it is a non-empty string.
 */
export function parsePublishedIndex(raw: unknown): PublishedSceneEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PublishedSceneEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const file = rec.file;
    if (typeof file !== 'string' || !/\.scene\.json$/i.test(file)) continue;
    const urlName = urlNameFromFile(file);
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const mode = typeof rec.mode === 'string' && rec.mode.trim() ? rec.mode.trim() : undefined;
    out.push({ file, urlName, label: name || urlName, mode });
  }
  return out;
}
