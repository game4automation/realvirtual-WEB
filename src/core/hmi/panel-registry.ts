// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { CommandContext } from './rv-command-registry';

// ui.panel.list/open/close: mounted windows and openers (a returned string refuses).
export interface PanelOpener { title: string; setOpen(open: boolean, target: string | undefined, ctx: CommandContext): string | void | Promise<string | void> }
export interface MountedPanel { title: string; open: boolean; close?: () => void }
export const panelOpeners = new Map<string, PanelOpener>();
export const mountedPanels = new Map<string, MountedPanel>();

function put<T>(map: Map<string, T>, id: string, v: T): () => void {
  map.set(id, v);
  return () => { if (map.get(id) === v) map.delete(id); };
}
export const registerPanelOpener = (id: string, o: PanelOpener) => put(panelOpeners, id, o);
export const notePanelMounted = (id: string, m: MountedPanel) => put(mountedPanels, id, m);
