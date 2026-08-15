// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signalRowLabel — find a CONNECT signal row by its name, unambiguously.
 *
 * A signal row prints its name twice, and always has: once as the row's own
 * label line, and once inside the `SignalBadge` chip beside it. That was
 * invisible to `getByText(name)` only because the chip used to render its whole
 * label as ONE text node ("A_Signal  InBool ●"), which an exact-text query does
 * not match.
 *
 * plan-422 F4 split the chip label so the NAME can ellipsise in CSS while the
 * reading keeps its width — and the name became its own text node. Both places
 * now match, so `getByText` throws "found multiple elements" on every row that
 * is actually visible.
 *
 * The row label is the one carrying the full name as its `title`, which is what
 * this helper keys on. Tests that mean "is this row on screen?" should ask for
 * the row label rather than for any element containing the text.
 */

import { waitFor } from '@testing-library/react';

function selector(name: string): string {
  return `p[title="${name.replace(/"/g, '\\"')}"]`;
}

/** The row label for `name`, or null when the row is not rendered. */
export function querySignalRowLabel(name: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(selector(name));
}

/** The row label for `name`. Throws when the row is not rendered. */
export function getSignalRowLabel(name: string): HTMLElement {
  const el = querySignalRowLabel(name);
  if (!el) throw new Error(`no signal row labelled "${name}"`);
  return el;
}

/** Wait for the row for `name` to appear, then return its label. */
export async function findSignalRowLabel(name: string): Promise<HTMLElement> {
  await waitFor(() => {
    if (!querySignalRowLabel(name)) throw new Error(`no signal row labelled "${name}"`);
  });
  return getSignalRowLabel(name);
}
