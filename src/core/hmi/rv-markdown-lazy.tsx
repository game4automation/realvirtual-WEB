// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-markdown-lazy.tsx — the ONE dynamic entry point to `react-markdown`
 * (plan-431 §2.5).
 *
 * ## Why both packages load together
 *
 * `remark-gfm` must never be imported statically anywhere. A static import would
 * pull it into the main chunk, which undoes the lazy decision and the bundle NFA
 * in one line — and dropping it instead is not an option either, because GFM
 * tables are what the existing notes are made of and the reason the dependency
 * was taken at all. So both live in ONE dynamic chunk, requested together.
 *
 * ## Why this is a module and not an inline `import()`
 *
 * A dynamic import is cached by the module system: after the first successful
 * load no later test can observe the pending or the failed state again. Routing
 * every load through one swappable function makes those two states reachable in
 * a test without touching the module cache — {@link __setMarkdownLoader}.
 *
 * NEVER add `rehype-raw` here. It is the one switch that turns note text back
 * into executable HTML; `react-markdown` refuses raw HTML by default and that
 * default is the whole security story of the field renderer (plan-431 F9).
 */

import type { ComponentType } from 'react';

/** What a loaded markdown chunk hands back. Typed structurally so a test double
 *  does not have to import the real packages. */
export interface MarkdownModule {
  /** The `react-markdown` default export. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ReactMarkdown: ComponentType<any>;
  /** The `remark-gfm` plugin, passed straight into `remarkPlugins`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  remarkGfm: any;
}

export type MarkdownLoader = () => Promise<MarkdownModule>;

/** Both packages, one dynamic chunk. See the module note. */
const defaultLoader: MarkdownLoader = async () => {
  const [markdown, gfm] = await Promise.all([
    import('react-markdown'),
    import('remark-gfm'),
  ]);
  return { ReactMarkdown: markdown.default, remarkGfm: gfm.default };
};

let loader: MarkdownLoader = defaultLoader;

/** Load `react-markdown` + `remark-gfm`. Called only from a lazy boundary —
 *  the node-knowledge field renderer, and since plan-445 the project browser's
 *  detail-pane Markdown preview. Never import the packages directly. */
export function loadMarkdown(): Promise<MarkdownModule> {
  return loader();
}

/**
 * Swap the loader — TESTS ONLY.
 *
 * Pass nothing to restore the real one. A test that replaces the loader is
 * responsible for restoring it, otherwise every later test in the file renders
 * against the double.
 */
export function __setMarkdownLoader(fn?: MarkdownLoader): void {
  loader = fn ?? defaultLoader;
}
