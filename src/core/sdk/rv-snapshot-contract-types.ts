// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

export type SnapshotJson = null | boolean | string | number
  | SnapshotJson[] | { [key: string]: SnapshotJson };
export type SnapshotCodec = 'map' | 'set' | 'number-tags';
export interface SnapshotSchema {
  readonly codecs?: Readonly<Record<string, SnapshotCodec>>;
}

export interface SnapshotOwnerDecl {
  path: string;
  owner: object;
  stateKeys: readonly string[];
  services?: readonly string[];
}

export interface Snapshottable {
  readonly captureIsEncoded?: boolean;
  readonly handleFields?: (json: SnapshotJson) => readonly ParticipantHandleField[];
  readonly key: string;
  readonly version: number;
  readonly dependencies?: readonly string[];
  readonly services?: readonly string[];
  readonly schema?: SnapshotSchema;
  readonly owner?: object;
  readonly stateKeys?: readonly string[];
  /** Every concrete state owner of an aggregated participant. */
  owners?(): Iterable<SnapshotOwnerDecl>;
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
  /** Queue component identity; null for a global action. */
  owner: string | null;
  alternatives: readonly { action: string; kind: string | null }[];
  notify?: boolean;
  zone?: string;
}

export interface SnapshotPart { key: string; version: number; state: SnapshotJson }
export interface SnapshotStateNotDeclaredError {
  code: 'des-state-not-declared';
  participant: string;
  property: string;
  owner?: string;
}

/** Structural view of the frame needed by external providers. */
export interface SnapshotProviderFrame {
  simTime: number;
  parts: readonly SnapshotPart[];
  eventQueue: readonly {
    id: number; time: number; action: string; componentId: string | null;
    muId: number; priority: number; data?: SnapshotJson;
  }[];
}
export type SnapshotProvider = (ctx: {
  raw?: SnapshotProviderFrame;
  restoring: boolean;
}) => readonly Snapshottable[];
