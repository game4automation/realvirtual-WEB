// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { snapshotUserMessage } from '../../core/sdk/rv-des-snapshot-messages';

/**
 * Declarative participant registry for the additive plan-2059 snapshot frame.
 *
 * Registration declares restore dependencies and the capture boundary, without
 * activating any restore path. Topological order always picks the earliest
 * registered ready participant. Capture checks all owner own keys (including
 * non-enumerable and symbol keys), then collects live DTOs and copies them in
 * one shared identity session. Schemas validate only after the whole contract
 * passes, so copying cannot conceal cross-participant aliases.
 *
 * services classifies non-state owner fields; stateKeys declares state fields.
 * This capture-only guard is a completeness check, not a hot-path observer.
 * It cannot inspect closure state or prove continuation equivalence. prepare,
 * commit and onRestore are intentionally never called by this module.
 */

import {
  fromSnapshotData, type CaptureSession, type SnapshotJson, type SnapshotSchema,
} from './rv-snapshot-contract';

export interface Snapshottable {
  /** Capture already applied this participant's explicit transport codecs. */
  readonly captureIsEncoded?: boolean;
  /** Participant-relative handles, expanded per list/map element without mutation. */
  readonly handleFields?: (json: SnapshotJson) => readonly ParticipantHandleField[];
  readonly key: string;
  readonly version: number;
  readonly dependencies?: readonly string[];
  readonly services?: readonly string[];
  readonly schema?: SnapshotSchema;
  readonly owner?: object;
  readonly stateKeys?: readonly string[];
  claimsDrives?(): readonly object[];
  capture(): unknown;
  validate(json: SnapshotJson): readonly string[];
  prepare(json: SnapshotJson): unknown;
  commit(prepared: unknown): void;
  onRestore?(): void;
}

export interface ParticipantHandleField {
  path: string;
  eventId: number;
  owner: string;
  alternatives: readonly { action: string; kind: string | null }[];
  notify?: boolean;
  zone?: string;
}

export interface SnapshotPart { key: string; version: number; state: SnapshotJson }
export interface SnapshotStateNotDeclaredError {
  code: 'des-state-not-declared';
  participant: string;
  property: string;
}

export class SnapshotRegistry {
  private readonly participants = new Map<string, Snapshottable>();

  register(participant: Snapshottable): void {
    if (!participant.key.trim() || !Number.isSafeInteger(participant.version) || participant.version < 1)
      throw new Error(`invalid participant '${participant.key}': non-empty key and positive integer version required`);
    if (this.participants.has(participant.key)) throw new Error(`duplicate participant '${participant.key}'`);
    this.participants.set(participant.key, participant);
  }

  unregister(key: string): void { this.participants.delete(key); }

  /** Missing dependencies and cycles fail before invoking any participant. */
  order(): Snapshottable[] {
    const pending = [...this.participants.values()];
    for (const p of pending) for (const dep of p.dependencies ?? []) {
      if (!this.participants.has(dep)) throw new Error(`missing dependency '${dep}' for '${p.key}'`);
    }
    const ordered: Snapshottable[] = [];
    const done = new Set<string>();
    while (pending.length) {
      const i = pending.findIndex(p => (p.dependencies ?? []).every(dep => done.has(dep)));
      if (i < 0) throw new Error(`participant dependency cycle: ${pending.map(p => p.key).join(' -> ')}`);
      const [p] = pending.splice(i, 1);
      ordered.push(p);
      done.add(p.key);
    }
    return ordered;
  }

  /** Synchronous capture: returned parts share no references with live state. */
  captureAll(session: CaptureSession): SnapshotPart[] {
    const ordered = this.order();
    const undeclared: SnapshotStateNotDeclaredError[] = [];
    for (const p of ordered) {
      if (!p.owner) continue;
      const allowed = new Set([...(p.stateKeys ?? []), ...(p.services ?? [])]);
      for (const key of Reflect.ownKeys(p.owner)) {
        if (typeof key === 'string' && allowed.has(key)) continue;
        undeclared.push({ code: 'des-state-not-declared', participant: p.key, property: String(key) });
      }
    }
    if (undeclared.length) throw Object.assign(new Error(undeclared.map(e =>
      `${e.code}: ${e.participant}.${e.property}`).join('\n')), { ...undeclared[0], userMessage: snapshotUserMessage(undeclared[0].code).text, errors: undeclared });

    const raw = ordered.map(p => ({ p, value: p.capture() }));
    const parts: SnapshotPart[] = [];
    const failures: unknown[] = [];
    for (const { p, value } of raw) {
      const before = session.errors().length;
      try { parts.push({ key: p.key, version: p.version, state: session.capture(p.key,
        p.captureIsEncoded ? fromSnapshotData(value, { participant: p.key, ...p.schema }) : value, p.schema) }); }
      catch (error) {
        // Unexpected failures (e.g. a hostile Proxy trap) must retain their cause.
        if (session.errors().length === before) throw error;
        failures.push(error);
      }
    }
    const contractErrors = session.errors();
    if (failures.length || contractErrors.length) throw Object.assign(new Error(contractErrors
      .map(e => `${e.code}: ${e.participant}.${e.path}: ${e.reason}`).join('\n')),
    { ...contractErrors[0], errors: contractErrors, causes: failures });

    const invalid: string[] = [];
    parts.forEach((part, i) => {
      for (const reason of ordered[i].validate(part.state)) invalid.push(`${part.key}: ${reason}`);
    });
    if (invalid.length) throw new Error(`des-snapshot-contract: ${invalid.join('; ')}`);
    return parts;
  }
}
