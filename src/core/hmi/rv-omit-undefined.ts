// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * omitUndefined — drop the keys whose value is `undefined` (plan-422 F1).
 *
 * ## Why a helper rather than four careful object literals
 *
 * The signal-bind payload travels through four hand-written copies on its way
 * from a drag source to a persisted `SignalMapping` — the badge drag
 * (`rv-signal-badge.tsx`), the row drop handler (`rv-signal-slot-row.tsx`) and
 * the two pickers (`SignalBindPopover.tsx`, `InlineSignalSlots.tsx`). Each of
 * them spells out every optional key, so an absent value does not stay absent:
 * it becomes a PRESENT key holding `undefined`.
 *
 * That distinction is invisible in memory and fatal on save. The GLB bake
 * refuses any value `JSON.stringify` would silently change, and a present
 * `undefined` key is exactly such a value — so one topic-less CONNECT signal
 * used to abort the whole draft write and take every other unsaved edit of the
 * session with it (plan-422 diagnosis). Omitting the key instead of carrying it
 * empty is the cause-level fix; the bake hardening in
 * `rv-scene-settings-into-model.ts` is the belt to this pair of braces.
 *
 * Returns the input unchanged when there is nothing to drop, so the common case
 * allocates nothing beyond the `Object.entries` walk.
 */
export function omitUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  let dropped = false;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) { dropped = true; continue; }
    out[key] = entry;
  }
  return dropped ? (out as T) : value;
}
