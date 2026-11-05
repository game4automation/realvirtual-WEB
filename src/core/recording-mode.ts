// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * `?recording=1` (tutorial recorder, plan-2240): no self-opening tooltips, Problems panel or
 * startup dialogs. Not `RECORDING_CONTEXT`. Eager: keep it import-free. Docs: doc-extending-webviewer.md.
 */

const on = (search: string, key: string) => new URLSearchParams(search).get(key) === '1';
const here = () => (typeof location === 'undefined' ? '' : location.search);

/** Whether the recording mode is on (this page's URL unless `search` is given). */
export function isRecordingMode(search = here()): boolean {
  return on(search, 'recording');
}

/** Recording mode without `recordingWelcome=1`: the welcome dialog must not open itself. */
export function isWelcomeAutoOpenSuppressed(search = here()): boolean {
  return on(search, 'recording') && !on(search, 'recordingWelcome');
}
