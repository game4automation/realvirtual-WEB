// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * help-url — deterministic URL construction for the context-sensitive help
 * (plan-370) plus the one place that opens an external tab.
 *
 * CONSTRUCTION RULE — do not break it: `openExternal()` must be reachable
 * SYNCHRONOUSLY from the user's event handler. Any `await` between the click
 * and the `window.open()` call makes popup blockers swallow the tab. Everything
 * this module and `deriveHelpTopic()` do is therefore pure and synchronous.
 *
 * NOT the same as `DOC_BASE_URL` in tooltip/MetadataTooltipContent.tsx
 * (`https://doc.realvirtual.io/`). That constant resolves relative links out of
 * Unity `RuntimeMetadata` — customer content, different domain, different
 * lifecycle. Touching it would break customer tooltips; it stays as it is.
 */

import type { HelpTopic } from './help-topics';

/** Product documentation root — used unless a deployment overrides it. */
export const DEFAULT_DOC_BASE_URL = 'https://realvirtual.io/doc/web/';

/**
 * True when `candidate` is usable as a documentation base: a non-empty string
 * that parses as an absolute `http:`/`https:` URL. Anything else (empty,
 * whitespace, `javascript:`, `ftp:`, null, undefined) is ignored in favour of
 * the default — a misconfigured deployment must never turn the help button into
 * a script injection vector.
 */
function normalizeBaseUrl(candidate: string | null | undefined): string {
  if (typeof candidate !== 'string') return DEFAULT_DOC_BASE_URL;
  const trimmed = candidate.trim();
  if (!trimmed) return DEFAULT_DOC_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return DEFAULT_DOC_BASE_URL;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return DEFAULT_DOC_BASE_URL;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/**
 * Build the absolute documentation URL for a topic.
 *
 * `{ slug: 'planning/des' }` → `https://realvirtual.io/doc/web/planning/des/`
 * `{ slug: '' }`             → `https://realvirtual.io/doc/web/`
 * `{ slug: 'odt', anchor: 'x' }` → `…/odt/#x`
 */
export function buildHelpUrl(topic: HelpTopic, baseUrl?: string | null): string {
  const base = normalizeBaseUrl(baseUrl);
  const slug = (topic.slug ?? '').replace(/^\/+|\/+$/g, '');
  const page = slug ? `${base}${slug}/` : base;
  const anchor = topic.anchor ? topic.anchor.replace(/^#+/, '') : '';
  return anchor ? `${page}#${anchor}` : page;
}

/**
 * Open a URL in a new browser tab. `noopener,noreferrer` severs `window.opener`
 * so the documentation page can never reach back into the running HMI.
 *
 * Must be called synchronously from the originating event handler.
 */
export function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}
