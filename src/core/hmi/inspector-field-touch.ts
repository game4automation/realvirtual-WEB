// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * inspector-field-touch — "the AI is writing this Inspector field".
 *
 * The button choreography (button-sim-state / button-sim-store, plan-499)
 * addresses its target by a key rendered as `data-rv-button-id`. A Property
 * Inspector field row carries such a key too — {@link inspectorFieldKey} — so
 * a field write through MCP (`web_editor_set_field`, `web_execute("component.setFields", …)`) gets
 * the SAME hover → press → afterglow as a button: the row is the button.
 *
 * The one extra a field needs is a REVEAL: its component section may be
 * collapsed, or the field may sit in the collapsed "more fields" block. The
 * feedback layer requests the reveal here, every ComponentSection listens and
 * opens itself when it owns the field. No DOM, no timers.
 */

import { useSyncExternalStore } from 'react';

/** The button key of one Inspector field row. */
export function inspectorFieldKey(path: string, componentType: string, fieldName: string): string {
  return `inspector.field:${path}|${componentType}|${fieldName}`;
}

export interface InspectorFieldReveal {
  readonly path: string;
  readonly componentType: string;
  readonly fieldName: string;
  /** Changes on every request, so a repeat request re-opens a section the user closed. */
  readonly seq: number;
}

let reveal: InspectorFieldReveal | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Ask the Inspector to make this field's row visible (expand section / more-fields). */
export function requestInspectorFieldReveal(path: string, componentType: string, fieldName: string): void {
  reveal = { path, componentType, fieldName, seq: ++seq };
  for (const l of listeners) l();
}

/** The latest reveal request (null before the first one). */
export function getInspectorFieldReveal(): InspectorFieldReveal | null {
  return reveal;
}

/** React hook: the latest reveal request. */
export function useInspectorFieldReveal(): InspectorFieldReveal | null {
  return useSyncExternalStore(subscribe, getInspectorFieldReveal);
}

/** Test hook: drop the request. */
export function _resetInspectorFieldRevealForTest(): void {
  reveal = null;
  seq = 0;
}
