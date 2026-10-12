// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * metadata-link-resolver — where a RuntimeMetadata `<link url="…">` goes.
 *
 * Three answers, decided ONCE when the tooltip renders (so the click itself
 * stays synchronous — popup blockers swallow a `window.open` that follows an
 * `await`):
 *
 *   - **web**: an absolute `http(s)` URL → a new tab, unchanged.
 *   - **project**: a relative path that names a file of the OPEN project
 *     (`Kroenert Files/…/manual.pdf`) → the project backend hands out an object
 *     URL for it; a PDF opens in the built-in viewer, anything else in a new
 *     tab. This is the 3D-HMI case: a machine's manuals live next to the model,
 *     in the project folder, exactly like a `docs/` tree with `docs-index.json`
 *     — only addressed directly from the metadata instead of by part number.
 *   - **doc**: everything else → the realvirtual documentation site, the
 *     legacy meaning of a relative link in Unity demo content. A project that
 *     does not hold the file falls back here too, so an authored doc slug keeps
 *     working with a project open.
 */

/** The slice of `ProjectBackend` this module needs. */
export interface LinkFileSource {
  readDocumentUrl(relPath: string): Promise<{ url: string; release(): void } | null>;
}

export type MetadataLinkTarget =
  | { kind: 'web'; href: string }
  | { kind: 'project'; url: string; isPdf: boolean; release(): void }
  | { kind: 'doc'; href: string };

/** Documentation site a relative, non-project link resolves against. */
export const DOC_BASE_URL = 'https://doc.realvirtual.io/';

export function isAbsoluteHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Normalise an authored relative path to what a backend expects. */
function normaliseRelPath(url: string): string {
  return url.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export async function resolveMetadataLink(
  url: string,
  source: LinkFileSource | null | undefined,
): Promise<MetadataLinkTarget> {
  if (isAbsoluteHttpUrl(url)) return { kind: 'web', href: url };
  const relPath = normaliseRelPath(url);
  if (source && relPath) {
    let resolved: { url: string; release(): void } | null = null;
    try {
      resolved = await source.readDocumentUrl(relPath);
    } catch {
      resolved = null;
    }
    if (resolved) {
      return { kind: 'project', url: resolved.url, isPdf: /\.pdf$/i.test(relPath), release: resolved.release };
    }
  }
  return { kind: 'doc', href: `${DOC_BASE_URL}${url}` };
}
