// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-connection-edits.ts — op-construction helpers for typed connections
 * (plan-259). The single codepath every UI entry (inspector section, drag
 * drop, MCP) uses to create/remove connection edges and type signatures:
 * ops go through the SceneStore op log (undoable, draft-autosaved, folded by
 * `materialise()`); without a store (tests / standalone embeds) the edit is
 * applied directly to the session registry so behavior stays consistent.
 */

import { getSceneStore } from './scene-store-singleton';
import { freshOpId } from '../../ops/rv-op-utils';
import type {
  AddConnectionOp,
  RemoveConnectionOp,
  SetConnectionTypeOp,
  RemoveConnectionTypeOp,
} from './rv-scene-edits';
import {
  getConnectionSystem,
  type RvConnection,
  type ConnectionType,
} from '../../engine/rv-connection-registry';

/** Mint a fresh connection edge id (`c_<base36-time>_<rand4>`). */
export function freshConnectionId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Add a connection edge (op-logged when a SceneStore is active). */
export function applyAddConnection(connection: RvConnection): void {
  const store = getSceneStore();
  if (!store) {
    getConnectionSystem().addConnection(connection);
    return;
  }
  const op: AddConnectionOp = {
    id: freshOpId(), ts: Date.now(), schemaV: 1,
    kind: 'addConnection', connection,
  };
  void store.applyOp(op);
}

/** Remove a connection edge (full snapshot carried for undo). */
export function applyRemoveConnection(connection: RvConnection): void {
  const store = getSceneStore();
  if (!store) {
    getConnectionSystem().removeConnection(connection.id);
    return;
  }
  const op: RemoveConnectionOp = {
    id: freshOpId(), ts: Date.now(), schemaV: 1,
    kind: 'removeConnection', connectionId: connection.id, connection,
  };
  void store.applyOp(op);
}

/** Add/replace a user-defined connection type signature. */
export function applySetConnectionType(connectionType: ConnectionType, prev: ConnectionType | undefined): void {
  const store = getSceneStore();
  if (!store) {
    getConnectionSystem().setConnectionType(connectionType);
    return;
  }
  const op: SetConnectionTypeOp = {
    id: freshOpId(), ts: Date.now(), schemaV: 1,
    kind: 'setConnectionType', connectionType, prev,
  };
  void store.applyOp(op);
}

/** Remove a user-defined connection type signature. */
export function applyRemoveConnectionType(connectionType: ConnectionType): void {
  const store = getSceneStore();
  if (!store) {
    getConnectionSystem().removeConnectionType(connectionType.type);
    return;
  }
  const op: RemoveConnectionTypeOp = {
    id: freshOpId(), ts: Date.now(), schemaV: 1,
    kind: 'removeConnectionType', connectionType,
  };
  void store.applyOp(op);
}

/** Update one config field on an existing edge (remove+add composite kept
 *  simple: a replace op pair would double history — instead we re-add the
 *  edge with the same id, which `addConnection` treats as replace). */
export function applyUpdateConnectionConfig(edge: RvConnection, field: string, value: unknown): void {
  const next: RvConnection = {
    ...edge,
    config: { ...(edge.config ?? {}), [field]: value },
  };
  const store = getSceneStore();
  if (!store) {
    getConnectionSystem().addConnection(next);
    return;
  }
  const op: AddConnectionOp = {
    id: freshOpId(), ts: Date.now(), schemaV: 1,
    kind: 'addConnection', connection: next,
  };
  void store.applyOp(op);
}
