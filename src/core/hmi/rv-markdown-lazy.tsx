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

import { Component, Suspense, lazy, useMemo, type ComponentType, type ReactNode } from 'react';

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

// ─── The one rendering boundary ─────────────────────────────────────────

/**
 * Catches a REJECTED markdown chunk (offline, purged CDN, blocked asset).
 *
 * `Suspense` handles a pending promise and nothing else — a rejected dynamic
 * import throws, and without a boundary here that throw takes the surrounding
 * subtree down with it. This is the single most common mistake in code-split
 * React, and it is the reason plan-431 F7 names both mechanisms.
 */
class MarkdownErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('[NodeKnowledge] markdown chunk failed to load, showing raw note', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * Render `text` as Markdown through the one lazy chunk.
 *
 * Built per mount (`useMemo` with no deps), so each mounted instance asks
 * {@link loadMarkdown} exactly once — that is what lets a test swap in a pending
 * or rejecting loader and actually observe the state.
 *
 * The two call sites keep the behaviour they had before they shared this
 * component (plan-461 V11):
 *
 *  - the node-knowledge field renderer passes `components` and
 *    `errorBoundary: true`, so a rejected chunk falls back to the raw note;
 *  - the project browser's detail pane passes neither, so a rejected chunk
 *    still throws to whatever boundary is above it, exactly as it always did.
 *
 * `fallback` is used by BOTH mechanisms — the pending state and, when the
 * boundary is on, the failed one.
 */
export function LazyMarkdown({
  text,
  components,
  fallback,
  errorBoundary = false,
}: {
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components?: any;
  fallback: ReactNode;
  errorBoundary?: boolean;
}) {
  const Lazy = useMemo(
    () => lazy(async () => {
      const { ReactMarkdown, remarkGfm } = await loadMarkdown();
      return {
        default: ({ source }: { source: string }) => (
          components
            ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
                {source}
              </ReactMarkdown>
            )
            : <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
        ),
      };
    }),
    // Deliberately empty: both call sites hand over a module-level constant (or
    // nothing), and re-creating the lazy component would re-request the chunk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const body = (
    <Suspense fallback={fallback}>
      <Lazy source={text} />
    </Suspense>
  );
  return errorBoundary
    ? <MarkdownErrorBoundary fallback={fallback}>{body}</MarkdownErrorBoundary>
    : body;
}
