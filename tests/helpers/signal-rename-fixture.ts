// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-590 — shared harness for the signal-rename planner / coordinator tests.
 *
 * Builds on the plan-589 sync fixture (REAL SignalStore, NodeRegistry, loader
 * traversal and AssetExecutorContext) and adds:
 *
 *  - two REAL `RvDocument`s over that executor — `asset` (the model document)
 *    and `scene` (the overlay document) — wrapped as rename document targets;
 *  - an in-memory CONNECT gateway ({@link FakeConnect}) with revisions,
 *    operation-id status, wire effects and failure injection;
 *  - in-memory planner placements, historian selection and Problems sink;
 *  - an optional fake PLC seam that writes `PLCProgram.Code` through the
 *    document target exactly like the private adapter does.
 */

import type { Group } from 'three';
import { RvDocument } from '../../src/core/ops/rv-document';
import type { RvExecutor } from '../../src/core/ops/rv-unified-executors';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import type {
  ConnectSignalRenameOutcome, ConnectSignalRenameStatus, ConnectSignalRenameWireChange,
} from '../../src/core/hmi/connect-store';
import type { ProblemInput } from '../../src/core/hmi/problems-store';
import {
  SignalRenameCoordinator,
  createSignalRenameDocTarget,
  type SignalRenameDocTarget,
  type SignalRenameEnvironment,
} from '../../src/core/engine/rv-signal-rename-coordinator';
import type {
  SignalRenameConnectPort, SignalRenameMapping, SignalRenamePlcAdapter, SignalRenamePlcPlan,
} from '../../src/core/engine/rv-signal-rename';
import { head, makeSyncFixture, type SyncFixture } from './signal-sync-fixture';

export { head, node, plc } from './signal-sync-fixture';

/** Failure modes of the next NON-preview CONNECT call. */
export type ConnectFailure =
  | 'error'            // no answer, nothing happened (status unknown to the gateway)
  | 'lost-committed'   // committed, but the answer was lost
  | 'lost-pending'     // no answer, status stays 'pending'
  | 'mismatch'         // 409 revision-mismatch
  | 'collision'        // 409 name-collision
  | 'unsupported'      // old gateway
  | 'failed-after-persist';

/** An in-memory CONNECT gateway with the rename endpoint's contract (plan §2.5). */
export class FakeConnect implements SignalRenameConnectPort {
  connected = true;
  names = new Set<string>();
  revision = 1;
  wire: ConnectSignalRenameWireChange[] = [];
  inactiveProfiles: string[] = [];
  /** Consumed by apply calls (never by previews), first in first out. */
  failNext: ConnectFailure[] = [];
  /** Answer every preview with `unsupported` (old gateway). */
  unsupported = false;
  readonly statuses = new Map<string, ConnectSignalRenameStatus>();
  readonly calls: Array<{ from: string; to: string; preview: boolean; revision: string | null; operationId: string | null }> = [];
  /** Called on every apply BEFORE anything happens (journal-order assertions). */
  onApply: (() => void) | null = null;

  constructor(names: string[] = []) { for (const n of names) this.names.add(n); }

  get rev(): string { return `r${this.revision}`; }

  isConnected(): boolean { return this.connected; }

  interfaces(): ReturnType<SignalRenameConnectPort['interfaces']> {
    return [{ id: 'S7', signals: [...this.names].map((name) => ({ name })) }];
  }

  async renameSignal(
    from: string, to: string, renameRevision: string | null, preview: boolean, operationId: string | null,
  ): Promise<ConnectSignalRenameOutcome> {
    this.calls.push({ from, to, preview, revision: renameRevision, operationId });
    if (this.unsupported) return { kind: 'unsupported' };
    if (preview) {
      if (this.names.has(to) && this.names.has(from)) return { kind: 'name-collision', renameRevision: this.rev };
      const known = this.names.has(from);
      return {
        kind: 'ok',
        result: {
          operationId: null, status: 'preview', renameRevision: this.rev,
          changedInterfaces: known ? [{ id: 'S7' }] : [], changedMappings: 0,
          wireChanges: known ? [...this.wire] : [], inactiveProfiles: [...this.inactiveProfiles],
          storeRenamed: false, liveInGateway: known,
        },
      };
    }
    this.onApply?.();
    const fail = this.failNext.shift();
    const op = operationId ?? 'none';
    switch (fail) {
      case 'error': return { kind: 'error', message: 'connection reset' };
      case 'lost-pending': this.statuses.set(op, 'pending'); return { kind: 'error', message: 'timeout' };
      case 'mismatch': return { kind: 'revision-mismatch', renameRevision: this.rev };
      case 'collision': return { kind: 'name-collision', renameRevision: this.rev };
      case 'unsupported': return { kind: 'unsupported' };
      default: break;
    }
    if (renameRevision !== this.rev) return { kind: 'revision-mismatch', renameRevision: this.rev };
    if (this.names.has(to) && this.names.has(from)) return { kind: 'name-collision', renameRevision: this.rev };
    if (this.names.delete(from)) this.names.add(to);
    this.revision++;
    if (fail === 'failed-after-persist') {
      this.statuses.set(op, 'failed-after-persist');
      return { kind: 'failed-after-persist', operationId: op };
    }
    this.statuses.set(op, 'committed');
    if (fail === 'lost-committed') return { kind: 'error', message: 'timeout' };
    return {
      kind: 'ok',
      result: {
        operationId: op, status: 'committed', renameRevision: this.rev,
        changedInterfaces: [{ id: 'S7' }], changedMappings: 0, wireChanges: [], inactiveProfiles: [],
        storeRenamed: true, liveInGateway: true,
      },
    };
  }

  async fetchStatus(operationId: string): Promise<ConnectSignalRenameStatus | null> {
    return this.statuses.get(operationId) ?? null;
  }
}

/** In-memory planner placements. */
export class FakePlaced {
  placements: Array<{ id: string; label?: string; signalMappings?: SignalRenameMapping[] }> = [];
  failUpdate = 0;
  list() { return this.placements; }
  update(id: string, mappings: SignalRenameMapping[]): void {
    if (this.failUpdate > 0) { this.failUpdate--; throw new Error('planner store refused'); }
    this.placements = this.placements.map((p) => (p.id === id ? { ...p, signalMappings: mappings } : p));
  }
}

/** In-memory historian selection. */
export class FakeHistorian {
  selection: string[] = [];
  failSet = 0;
  selected(): readonly string[] { return this.selection; }
  setSelected(names: string[]): void {
    if (this.failSet > 0) { this.failSet--; throw new Error('historian refused'); }
    this.selection = [...names];
  }
}

/** Problems sink. */
export class FakeProblems {
  readonly entries = new Map<string, ProblemInput>();
  report(p: ProblemInput): void { this.entries.set(p.id, p); }
  clear(id: string): void { this.entries.delete(id); }
}

/**
 * A PLC seam that renames by appending / replacing the pragma line-wise —
 * enough for the coordinator tests (the real rules are tested privately).
 * `writePlcCode` writes through the document target, like the private one.
 */
export class FakePlc implements SignalRenamePlcAdapter {
  failWrite = 0;
  readonly buffers = new Map<string, string>();
  readonly writes: Array<{ nodePath: string; code: string }> = [];
  constructor(private readonly programs: () => Array<{ path: string; name: string; code: string }>) {}
  planRename(_scene: unknown, oldName: string, newName: string): SignalRenamePlcPlan {
    const plan: SignalRenamePlcPlan = { edits: [], blockers: [] };
    for (const p of this.programs()) {
      const decl = `${oldName} : BOOL;`;
      if (!p.code.includes(decl)) continue;
      plan.edits.push({
        nodePath: p.path, programName: p.name, prevCode: p.code,
        nextCode: p.code.replace(decl, `${decl} (* @signal: ${newName} *)`), change: 'pragma-added', lines: [2],
      });
    }
    return plan;
  }
  async writePlcCode(
    doc: Parameters<SignalRenamePlcAdapter['writePlcCode']>[0], nodePath: string, code: string,
  ): Promise<void> {
    if (this.failWrite > 0) { this.failWrite--; throw new Error('PLC write refused'); }
    const prev = doc.readField(nodePath, 'PLCProgram', 'Code');
    await doc.setField(nodePath, 'PLCProgram', 'Code', code, prev);
    this.writes.push({ nodePath, code });
  }
  refreshBuffer(nodePath: string, code: string, replaces?: string): void {
    if (replaces !== undefined && this.buffers.has(nodePath) && this.buffers.get(nodePath) !== replaces) return;
    this.buffers.set(nodePath, code);
  }
}

/** A document target whose `setField` can be told to fail for one field. */
export interface FailableTarget extends SignalRenameDocTarget {
  /** Field name whose next setField rejects (once). */
  failField: string | null;
}

export interface RenameFixture extends SyncFixture {
  asset: RvDocument;
  /** The overlay document (named `sceneDoc` — `scene` is the THREE scene of the sync fixture). */
  sceneDoc: RvDocument;
  assetTarget: FailableTarget;
  sceneTarget: FailableTarget;
  connect: FakeConnect;
  placed: FakePlaced;
  historian: FakeHistorian;
  problems: FakeProblems;
  plcAdapter: FakePlc | null;
  env: SignalRenameEnvironment;
  coordinator: SignalRenameCoordinator;
}

function failableTarget(
  f: SyncFixture, document: RvDocument, kind: 'asset-doc' | 'scene-doc',
): FailableTarget {
  const target = createSignalRenameDocTarget({
    viewer: f.viewer, kind, document,
    setField: async (nodePath, componentType, fieldName, value, prev) => {
      if (target.failField === fieldName) {
        target.failField = null;
        throw new Error(`setField ${componentType}.${fieldName} refused`);
      }
      await document.applyOp({
        ...head(), kind: 'setField', nodePath, componentType, fieldName, value, prev,
      } as RvOp);
    },
  }) as FailableTarget;
  target.failField = null;
  return target;
}

/** Build the harness. `opts.plc` installs the fake PLC seam (else `plc: null`). */
export function makeRenameFixture(
  populate: (root: Group) => void,
  opts: { connectNames?: string[]; plc?: boolean; sharedDocument?: boolean } = {},
): RenameFixture {
  const f = makeSyncFixture(populate);
  const executor = f.exec as unknown as RvExecutor;
  const asset = new RvDocument({ id: 'asset-doc', name: 'Asset', mode: 'asset', executor });
  const sceneDoc = opts.sharedDocument ? asset : new RvDocument({ id: 'scene-doc', name: 'Scene', mode: 'scene', executor });
  const assetTarget = failableTarget(f, asset, 'asset-doc');
  const sceneTarget = opts.sharedDocument ? assetTarget : failableTarget(f, sceneDoc, 'scene-doc');
  const connect = new FakeConnect(opts.connectNames ?? []);
  const placed = new FakePlaced();
  const historian = new FakeHistorian();
  const problems = new FakeProblems();
  const plcAdapter = opts.plc
    ? new FakePlc(() => {
      const out: Array<{ path: string; name: string; code: string }> = [];
      f.registry.forEachNode((path, n) => {
        const data = (n.userData.realvirtual as Record<string, Record<string, unknown>> | undefined)?.PLCProgram;
        if (data && f.registry.getPathForNode(n) === path) {
          out.push({ path, name: String(data.Name ?? 'Main'), code: String(data.Code ?? '') });
        }
      });
      return out;
    })
    : null;
  let seq = 0;
  const env: SignalRenameEnvironment = {
    docs: { model: assetTarget, overlay: sceneTarget },
    connect, placed, historian, problems, plc: plcAdapter,
    statusPoll: { attempts: 3, delayMs: 0 },
    sleep: async () => {},
    newId: () => `id${++seq}`,
  };
  const coordinator = new SignalRenameCoordinator(f.viewer, () => env);
  return {
    ...f, asset, sceneDoc, assetTarget, sceneTarget, connect, placed, historian, problems, plcAdapter, env, coordinator,
  };
}

/** Plan with the fixture's environment. */
export function planIn(f: RenameFixture, path: string, newName: string) {
  return f.coordinator.plan(path, newName);
}

/** Field of a node's extras. */
export function field(f: SyncFixture, path: string, componentType: string, name: string): unknown {
  const n = f.registry.getNode(path);
  return (n?.userData.realvirtual as Record<string, Record<string, unknown>> | undefined)?.[componentType]?.[name];
}
