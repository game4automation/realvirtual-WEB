// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, writeLocalStorage } from '../rv-safe-storage';

/**
 * rv-variant-ui-mode — the "Variant management" switch of Concept D (plan-2013).
 *
 * Concept D has no Settings row: the switch sits in the Property Inspector's ⋮ menu, next
 * to the thing it changes. It is a VIEW preference, so it is remembered per user and per
 * DOCUMENT in localStorage — never in the document model. Resolution:
 *
 *   explicit decision for this document  >  auto-on when the document has variants  >  off
 *
 * So a document with variants opens with the icons visible (nobody has to find the switch),
 * a document without variants looks exactly like today, and switching off survives a reload
 * — the contradiction of a per-session switch (off, reload, icons back) that Codex flagged.
 *
 * This module is eager and tiny on purpose (the variants runtime, its index and every UI
 * part stay behind `import()`): it holds the preference and the CONTEXT the eager plugin
 * publishes, so the inspector can render the menu item without importing anything variant.
 */

const KEY = 'rv-variants-ui-mode';

/** What the eager variants plugin publishes about the open document. */
export interface VariantModeContext {
  /** Stable key of the open document (its model identity). */
  readonly docKey: string;
  /** The document carries a variants block. */
  readonly hasVariants: boolean;
  /** Turns the mode on/off: loads or tears down the runtime and its UI. */
  setMode(on: boolean): Promise<void>;
}

type Decisions = Record<string, '1' | '0'>;

const listeners = new Set<() => void>();
let context: VariantModeContext | null = null;
let version = 0;

function read(): Decisions {
  try {
    const raw = readLocalStorage(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Decisions : {};
  } catch { return {}; }
}

function write(d: Decisions): void {
  try { writeLocalStorage(KEY, JSON.stringify(d)); } catch { /* storage unavailable */ }
}

function publish(): void {
  version++;
  for (const fn of [...listeners]) fn();
}

/** Subscribe for React (`useSyncExternalStore`). */
export function subscribeVariantMode(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Snapshot version for React. */
export function variantModeVersion(): number { return version; }

/** The resolved mode of a document. */
export function variantModeOf(docKey: string, hasVariants: boolean): boolean {
  const stored = read()[docKey];
  if (stored === '1') return true;
  if (stored === '0') return false;
  return hasVariants;
}

/** Remembers the user's decision for a document (and drops a decision equal to the default). */
export function rememberVariantMode(docKey: string, on: boolean, hasVariants: boolean): void {
  const decisions = read();
  if (on === hasVariants) delete decisions[docKey];
  else decisions[docKey] = on ? '1' : '0';
  write(decisions);
  publish();
}

/** Published by the eager plugin on every document load (null = no document). */
export function setVariantModeContext(next: VariantModeContext | null): void {
  if (context === next) return;
  context = next;
  publish();
}

/** The open document's context, or null when variants are unavailable. */
export function getVariantModeContext(): VariantModeContext | null { return context; }

/** The mode of the open document (false without a context). */
export function variantModeActive(): boolean {
  return context ? variantModeOf(context.docKey, context.hasVariants) : false;
}
