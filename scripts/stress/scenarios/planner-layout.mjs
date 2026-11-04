// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * planner-layout — STUB. Sustained layout-planner editing: place, move, snap,
 * delete, undo/redo and save/reload many placements. Not implemented: the
 * runner refuses to start a stub and prints the checklist below.
 */

export const scenario = {
  id: 'planner-layout',
  title: 'Layout planner churn',
  description: 'Hundreds of place/move/snap/delete/undo cycles plus save/reload on the planner demo: placement leaks, undo integrity, save round-trip, picking speed.',
  status: 'stub',
  requires: {
    build: 'any',
    url: { projectUrl: '/demo-realvirtual/', doc: 'doc_demoplanner_gf4m6v' },
  },
  defaults: { duration: '30m' },
  checks: [
    'placement count after N × (add + delete) equals the start count; GroupRegistry member sets shrink back (no orphaned partitions)',
    'undo × k then redo × k restores an identical layout (compare a layout fingerprint)',
    'save → reload → identical fingerprint (references by address, no unresolvedPath)',
    'problems.list stays empty (no reference-cycle / placement-cap / override-orphaned)',
    'pick/hover round-trip p95 does not creep up with the number of placements',
    'generic: no memory growth (ModelCache must evict), no stalls, no console errors',
  ],
  todo: [
    'web_commands "layout" / "planner": collect the command ids for add, move, rotate, snap, delete, undo, redo, save',
    'Define a layout fingerprint (sorted placement ids + rounded transforms + asset refs) via a read command; record a gap finding if none exists',
    'Loop: add K library assets at grid positions, snap pairs, move, delete half, undo/redo; sample after each round (phase per round)',
    'Every R rounds: document save + reload the page (new openViewer) and compare fingerprints; restarting the page also isolates leaks per session',
    'Measure web_status detail=full cache counters to see whether baked assets are released after delete',
    'Teardown: restore the demo document (do not save over the shipped demo — work on a copy)',
  ],
};
