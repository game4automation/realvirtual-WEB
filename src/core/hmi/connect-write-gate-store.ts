// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-write-gate-store — who decided what about writing to a PLC (plan-562 F8).
 *
 * Two decisions live here, and they are deliberately NOT the same thing:
 *
 *  - **read only, don't ask again** — a durable answer per gateway + interface.
 *    Persisted, because "I know, this is a live machine" must survive a reload;
 *    the way back is the "Writes blocked" chip on the interface card, which
 *    opens the Edit dialog (a decision without a return path is a trap).
 *  - **closed for now** — the ✕ on the overlay. Session only: the user has not
 *    answered the question, only put it down, so the next session asks again.
 *
 * Keyed by `serverUrl|interfaceId`: the same interface id on another CONNECT is
 * another machine, and an answer given for the lab gateway must never silence
 * the prompt for the one standing next to the real line.
 *
 * Storage shape and the session fallback follow `ai-consent-store.ts`: the
 * persisted map holds only the EXCEPTION (`true`), so an unknown key reads as
 * "not decided" and the overlay still does its one job; a browser that refuses
 * localStorage keeps the answer for the session instead of re-asking on every
 * render pass.
 */

import { useSyncExternalStore } from 'react';
import { CONNECT_WRITE_GATE_READONLY_KEY } from './rv-storage-keys';

/** Decisions this session holds even though storage refused the write. */
const sessionReadOnly = new Set<string>();
/** Overlays the user closed in this session (never persisted). */
const sessionDismissed = new Set<string>();

const listeners = new Set<() => void>();
/** Bumped on every decision — the snapshot React subscribes to. */
let version = 0;

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Identity of one decision: the gateway AND the interface, never one of them. */
export function writeGateKey(serverUrl: string, interfaceId: string): string {
  return `${serverUrl}|${interfaceId}`;
}

function readStoredMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CONNECT_WRITE_GATE_READONLY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, boolean>;
  } catch {
    // Unreadable or disabled storage: the session set is the whole truth.
    return {};
  }
}

function writeStoredMap(map: Record<string, boolean>): void {
  try {
    localStorage.setItem(CONNECT_WRITE_GATE_READONLY_KEY, JSON.stringify(map));
  } catch {
    // Private mode or disabled storage: the in-memory decision carries the session.
  }
}

/** Did the user decide this interface stays read-only from this viewer? */
export function isWriteGateReadOnly(serverUrl: string, interfaceId: string): boolean {
  const key = writeGateKey(serverUrl, interfaceId);
  if (sessionReadOnly.has(key)) return true;
  return readStoredMap()[key] === true;
}

/** Record "read only, don't ask again" for this gateway + interface. */
export function markWriteGateReadOnly(serverUrl: string, interfaceId: string): void {
  const key = writeGateKey(serverUrl, interfaceId);
  sessionReadOnly.add(key);
  const map = readStoredMap();
  map[key] = true;
  writeStoredMap(map);
  notify();
}

/**
 * Drop the "read only" decision — the Edit dialog is the way back, so opening
 * the gate there must also clear the answer that hid the prompt.
 */
export function clearWriteGateReadOnly(serverUrl: string, interfaceId: string): void {
  const key = writeGateKey(serverUrl, interfaceId);
  sessionReadOnly.delete(key);
  const map = readStoredMap();
  if (key in map) {
    delete map[key];
    writeStoredMap(map);
  }
  notify();
}

/** Was the overlay for this interface closed in THIS session (✕, Escape)? */
export function isWriteGateDismissed(serverUrl: string, interfaceId: string): boolean {
  return sessionDismissed.has(writeGateKey(serverUrl, interfaceId));
}

/** Put the question down for this session without answering it. */
export function dismissWriteGateNotice(serverUrl: string, interfaceId: string): void {
  sessionDismissed.add(writeGateKey(serverUrl, interfaceId));
  notify();
}

/** React hook: re-render whenever a write-gate decision changes. */
export function useWriteGateDecisions(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

/** @internal Reset every decision (tests only). */
export function _resetWriteGateStore(): void {
  sessionReadOnly.clear();
  sessionDismissed.clear();
  try {
    localStorage.removeItem(CONNECT_WRITE_GATE_READONLY_KEY);
  } catch {
    // Nothing persisted, nothing to clear.
  }
  notify();
}
