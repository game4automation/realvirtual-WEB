// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * first-link-notice.ts — one-time overlay after the user's first signal link.
 *
 * Binding a signal does not merely feed one component: the moment a slot is
 * claimed, `liveControlled` goes up on the drive, and the model's internal
 * control stops driving it — in the demo model that is a single LogicStep
 * sequence plus the drives replay, so the whole sequence halts
 * (`rv-drives-playback.ts` bails out as soon as ONE recorded drive is live
 * controlled). Users read the stopped model as a defect unless they are told.
 *
 * Fires on the transition from "this element had no mapping" to "it has one",
 * and only for mappings written through the UI — restoring persisted mappings
 * on model load goes through `syncNodeSignalBindingPersistence`, never through
 * `write()`, so loading a prepared scene stays silent.
 *
 * Shown once per page load (module flag). There is no model-switch reset hook
 * to hang it on — `clearNodeSignalBindingPersistence()` has no callers — and
 * repeating the same sentence after every model change would be noise: the
 * point is made once.
 */

import { showInstruction } from '../../core/hmi/instruction-store';

const NOTICE_ID = 'signal-bind-first-link';

let shown = false;

/**
 * Report a mapping write. Emits the notice on the first 0 → n transition seen
 * in this page load; every later write is ignored.
 */
export function noteSignalMappingsWritten(prevCount: number, nextCount: number): void {
  if (shown || prevCount !== 0 || nextCount === 0) return;
  shown = true;
  showInstruction({
    id: NOTICE_ID,
    text: 'Externes Signal verknüpft — interne Steuerung nun nicht mehr aktiv.',
    anchor: { kind: 'edge', edge: 'bottom' },
    style: 'info',
    autoClearAfterMs: 9000,
    dismissible: true,
    source: 'signal-bind',
  });
}

/** @internal — test seam; production code never resets the flag. */
export function _resetFirstLinkNoticeForTests(): void {
  shown = false;
}
