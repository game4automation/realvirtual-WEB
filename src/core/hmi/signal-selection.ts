// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Multi-selection over the CONNECT signal list.
 *
 * Selection is keyed by TOPIC + NAME, not by name alone: a signal name is only unique within its
 * container, and the same name may legitimately appear in several ProcessImage topics of one
 * interface. Keying by name alone would make two unrelated rows select and delete together.
 * Indices are not usable either — the list is virtualized and re-renders freely.
 *
 * The order a range walks is the RENDERED order — the same `SignalListRow[]` the virtualizer
 * consumes — so a range follows what the user sees (filtered, collapsed and, for MQTT,
 * tree-ordered) rather than the config order underneath.
 *
 * Both flat (interface-level) and topic-nested signals take part. They live in different config
 * containers, which is why {@link groupKeysByTopic} exists: a delete has to patch `iface.signals`
 * and each `iface.topics[].signals` in the same single write.
 */

/** Separator that cannot occur in a topic or signal name. */
const SEP = '\u0000';

/** The part of a rendered signal row this module needs. Structurally satisfied by SignalListRow. */
export interface SelectableRow {
  kind: string;
  sig?: { name: string };
  flat?: boolean;
  topic?: string;
}

/** Stable identity of one selectable row. `topic` is undefined for interface-level signals. */
export function selectionKey(topic: string | undefined, name: string): string {
  return `${topic ?? ''}${SEP}${name}`;
}

/** Split a key back into its topic (undefined when flat) and signal name. */
export function parseSelectionKey(key: string): { topic?: string; name: string } {
  const at = key.indexOf(SEP);
  const topic = key.slice(0, at);
  return { topic: topic === '' ? undefined : topic, name: key.slice(at + 1) };
}

/** Keys of the selectable signals in rendered order — the spine every range walks. */
export function selectableKeys(rows: readonly SelectableRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.kind === 'signal' && r.sig) out.push(selectionKey(r.topic, r.sig.name));
  }
  return out;
}

/**
 * Keys from `anchor` to `target` inclusive, in rendered order.
 *
 * Direction-agnostic — spanning upwards behaves like downwards. When the anchor is no longer on
 * screen (a collapsed group or a changed filter can remove it between two clicks) this degenerates
 * to the target alone; silently selecting nothing would read as a broken click.
 */
export function rangeBetween(
  rows: readonly SelectableRow[],
  anchor: string | null,
  target: string,
): string[] {
  const keys = selectableKeys(rows);
  const to = keys.indexOf(target);
  if (to < 0) return [];
  const from = anchor === null ? -1 : keys.indexOf(anchor);
  if (from < 0) return [target];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return keys.slice(lo, hi + 1);
}

/** What one click on a signal row means. */
export type SelectionIntent = 'replace' | 'toggle' | 'range';

/** Classify a click. Shift wins over Ctrl/Meta, matching every file manager. */
export function selectionIntent(
  e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
): SelectionIntent {
  if (e.shiftKey) return 'range';
  if (e.ctrlKey || e.metaKey) return 'toggle';
  return 'replace';
}

/** Result of applying a click to the current selection. */
export interface SelectionResult {
  selected: ReadonlySet<string>;
  /** The anchor a following range spans from. */
  anchor: string | null;
}

/**
 * Apply one click to the selection.
 *
 * `replace` collapses to the clicked signal, `toggle` adds or removes it, `range` spans from the
 * anchor to the click. A successful range KEEPS the anchor, so the user can widen and narrow the
 * same range repeatedly from where they started — moving it would make the second Shift+click span
 * from the wrong end.
 */
export function applySelection(
  rows: readonly SelectableRow[],
  current: ReadonlySet<string>,
  anchor: string | null,
  target: string,
  intent: SelectionIntent,
): SelectionResult {
  if (intent === 'range') {
    const keys = rangeBetween(rows, anchor, target);
    // A range that could not resolve its anchor is really a plain pick, and that pick becomes the
    // new anchor — otherwise the next Shift+click would have nothing to span from either.
    const spanned = anchor !== null && keys.length > 1;
    return { selected: new Set(keys), anchor: spanned ? anchor : target };
  }
  if (intent === 'toggle') {
    const next = new Set(current);
    if (next.has(target)) next.delete(target);
    else next.add(target);
    return { selected: next, anchor: target };
  }
  return { selected: new Set([target]), anchor: target };
}

/**
 * Drop keys that no longer exist.
 *
 * Run after the signal list changes (delete, discovery, interface switch) so the selection cannot
 * carry a phantom into a later bulk delete. Returns the SAME set instance when nothing changed, so
 * React state updates stay no-ops.
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  available: readonly string[],
): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const alive = new Set(available);
  const next = new Set<string>();
  let changed = false;
  for (const key of selected) {
    if (alive.has(key)) next.add(key);
    else changed = true;
  }
  return changed ? next : selected;
}

/**
 * Split selected keys into the config containers a delete has to patch.
 *
 * `flat` holds interface-level signal names; `byTopic` maps a topic to the names selected inside
 * it. Both are needed because CONNECT stores the two in separate arrays, and a bulk delete must
 * land as ONE write across both.
 */
export function groupKeysByTopic(
  selected: ReadonlySet<string>,
): { flat: Set<string>; byTopic: Map<string, Set<string>> } {
  const flat = new Set<string>();
  const byTopic = new Map<string, Set<string>>();
  for (const key of selected) {
    const { topic, name } = parseSelectionKey(key);
    if (topic === undefined) {
      flat.add(name);
    } else {
      let bucket = byTopic.get(topic);
      if (!bucket) byTopic.set(topic, bucket = new Set<string>());
      bucket.add(name);
    }
  }
  return { flat, byTopic };
}
