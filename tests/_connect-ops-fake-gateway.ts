// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * A small in-memory CONNECT for the plan-2025 P7 client tests: `GET /config*` with the store
 * revision headers, `POST /config/ops` with the patch semantics of `Core/ConfigOps.cs` (the subset
 * the browser sends), optimistic concurrency (`409 revision-conflict`), and the rename route with
 * `storeRevision` (an apply checks its `renameRevision`; a repeated apply with the same operation id
 * returns the remembered first outcome, like `SignalRenameOperations`). `ops: false` turns it into an
 * older CONNECT (404 on `/config/ops`). `breakOpsBody` commits the next batch and then breaks the
 * answer's body (the connection drops after the status line).
 *
 * Not a test file (no `.test.` in the name): imported by the tests that need it.
 */

import { vi } from 'vitest';
import type {
  ConnectConfigOp,
  ConnectInterface,
  ConnectInterfaceSignal,
  ConnectMirrorRule,
  ConnectSignalMapping,
} from '../src/core/hmi/connect-store';

export interface FakeGatewayCall { method: string; path: string; body: unknown }

export interface FakeGateway {
  interfaces: ConnectInterface[];
  mirrors: ConnectMirrorRule[];
  mappings: ConnectSignalMapping[];
  revision: number;
  instance: string;
  /** false = an older CONNECT without the write core. */
  ops: boolean;
  /** false = an older CONNECT without the rename route. */
  rename: boolean;
  calls: FakeGatewayCall[];
  /** Answer the next n `/config/ops` with this status/body instead of applying them. */
  failOps: Array<{ status: number; body: unknown }>;
  /** Drop the answer of the next rename APPLY (network error after the commit). */
  loseRenameAnswer: boolean;
  renameStatus: Map<string, string>;
  /** Remembered rename apply outcomes by operation id (status + body). */
  renameResults: Map<string, { status: number; body: unknown }>;
  /** Forget every remembered rename outcome (CONNECT restarted / the id was evicted). */
  forgetRenames(): void;
  /** Commit the next n `/config/ops` batches, then break the answer body after the status line. */
  breakOpsBody: number;
  /** Called right after a rename apply committed (before the answer leaves) — e.g. a concurrent write. */
  afterRenameCommit: (() => void) | null;
  /** Simulate a write by another client: bump the revision. */
  bump(): void;
  opsCalls(): Array<{ expectedRevision?: number; expectedInstance?: string; ops: ConnectConfigOp[] }>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Promise.resolve(new Response(
  JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } },
));

function containerOf(iface: ConnectInterface, topic: string | undefined): ConnectInterfaceSignal[] | null {
  if (topic === undefined || topic === null) return iface.signals ??= [];
  const t = (iface.topics ?? []).find(x => x.topic === topic);
  return t ? (t.signals ??= []) : null;
}

function mergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    const cur = target[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      mergePatch(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = structuredClone(v);
    }
  }
}

/** Apply one op; returns the result or throws a string error (rejects the batch). */
function applyOp(gw: FakeGateway, op: ConnectConfigOp, index: number): Record<string, unknown> {
  const iface = op.interfaceId ? gw.interfaces.find(i => i.id === op.interfaceId) : undefined;
  switch (op.op) {
    case 'signal.upsert': {
      if (!iface) throw `interface-not-found: '${op.interfaceId}'`;
      const list = containerOf(iface, op.topic);
      if (!list) throw `topic-not-found: '${op.topic}'`;
      const at = list.findIndex(s => s.name === op.name);
      if (at < 0) {
        if (!op.type) throw `type-required: '${op.name}'`;
        const created: ConnectInterfaceSignal = { name: op.name!, type: op.type, protocolAddress: op.protocolAddress ?? '', record: false };
        for (const f of ['dataType', 'comment', 'record', 'subscribeValue', 'pollValue', 'pollCycleMs'] as const) {
          if (op[f] !== undefined) (created as unknown as Record<string, unknown>)[f] = op[f];
        }
        list.push(created);
        return { index, op: op.op, outcome: 'created' };
      }
      const s = list[at] as unknown as Record<string, unknown>;
      const before = JSON.stringify(s);
      let addressKept = false;
      if (op.protocolAddress !== undefined) {
        const mode = op.addressMode ?? 'fillEmpty';
        const take = mode === 'overwrite' || (mode === 'fillEmpty' && !s.protocolAddress);
        if (take) s.protocolAddress = op.protocolAddress;
        else addressKept = s.protocolAddress !== op.protocolAddress;
      }
      for (const f of ['type', 'dataType', 'comment', 'record', 'subscribeValue', 'pollValue', 'pollCycleMs'] as const) {
        if (op[f] !== undefined) s[f] = op[f];
      }
      return { index, op: op.op, outcome: JSON.stringify(s) === before ? 'unchanged' : 'updated', ...(addressKept ? { addressKept } : {}) };
    }
    case 'signal.remove': {
      if (!iface) throw `interface-not-found: '${op.interfaceId}'`;
      const list = containerOf(iface, op.topic);
      if (!list) throw `topic-not-found: '${op.topic}'`;
      const at = list.findIndex(s => s.name === op.name);
      if (at < 0) return { index, op: op.op, outcome: 'unchanged' };
      list.splice(at, 1);
      return { index, op: op.op, outcome: 'removed' };
    }
    case 'interface.patch': {
      if (!iface) throw `interface-not-found: '${op.interfaceId}'`;
      const before = JSON.stringify(iface);
      mergePatch(iface as unknown as Record<string, unknown>, op.patch ?? {});
      return { index, op: op.op, outcome: JSON.stringify(iface) === before ? 'unchanged' : 'updated', id: iface.id };
    }
    case 'interface.add': {
      const body = structuredClone(op.interface!) as ConnectInterface;
      if (gw.interfaces.some(i => i.id === body.id)) throw `interface-exists: '${body.id}'`;
      body.signals ??= [];
      gw.interfaces.push(body);
      return { index, op: op.op, outcome: 'created', id: body.id };
    }
    case 'container.replace': {
      if (!iface) throw `interface-not-found: '${op.interfaceId}'`;
      if (op.topicConfig) {
        const topics = iface.topics ??= [];
        const at = topics.findIndex(t => t.topic === op.topicConfig!.topic);
        if (at >= 0) topics[at] = structuredClone(op.topicConfig); else topics.push(structuredClone(op.topicConfig));
        return { index, op: op.op, outcome: at >= 0 ? 'updated' : 'created' };
      }
      iface.signals = structuredClone(op.signals ?? []);
      return { index, op: op.op, outcome: 'updated' };
    }
    case 'mirror.upsert': {
      const rule = structuredClone(op.mirror!);
      if (!rule.id) rule.id = `mr-${(gw.mirrors.length + 1).toString(16).padStart(8, '0')}`;
      const at = gw.mirrors.findIndex(m => m.id === rule.id);
      if (at >= 0) gw.mirrors[at] = rule; else gw.mirrors.push(rule);
      return { index, op: op.op, outcome: at >= 0 ? 'updated' : 'created', id: rule.id };
    }
    case 'mirror.remove': {
      const before = gw.mirrors.length;
      gw.mirrors = gw.mirrors.filter(m => m.id !== op.id);
      return { index, op: op.op, outcome: gw.mirrors.length < before ? 'removed' : 'unchanged', id: op.id };
    }
    case 'mapping.upsert': {
      const m = structuredClone(op.mapping!);
      const at = gw.mappings.findIndex(x => x.sourceSignal === m.sourceSignal && x.destSignal === m.destSignal);
      if (at >= 0) gw.mappings[at] = m; else gw.mappings.push(m);
      return { index, op: op.op, outcome: at >= 0 ? 'updated' : 'created' };
    }
    case 'mapping.remove': {
      const before = gw.mappings.length;
      gw.mappings = gw.mappings.filter(x => !(x.sourceSignal === op.sourceSignal && x.destSignal === op.destSignal));
      return { index, op: op.op, outcome: gw.mappings.length < before ? 'removed' : 'unchanged' };
    }
    default:
      throw `unknown-op: '${(op as { op: string }).op}'`;
  }
}

/** Install the fake as `fetch`. */
export function installFakeGateway(init: Partial<Pick<FakeGateway, 'interfaces' | 'mirrors' | 'mappings' | 'ops' | 'rename' | 'revision'>> = {}): FakeGateway {
  const gw: FakeGateway = {
    interfaces: structuredClone(init.interfaces ?? []),
    mirrors: structuredClone(init.mirrors ?? []),
    mappings: structuredClone(init.mappings ?? []),
    revision: init.revision ?? 10,
    instance: 'inst-a',
    ops: init.ops ?? true,
    rename: init.rename ?? true,
    calls: [],
    failOps: [],
    loseRenameAnswer: false,
    renameStatus: new Map(),
    renameResults: new Map(),
    forgetRenames() { gw.renameResults.clear(); gw.renameStatus.clear(); },
    breakOpsBody: 0,
    afterRenameCommit: null,
    bump() { gw.revision++; },
    opsCalls() {
      return gw.calls.filter(c => c.method === 'POST' && c.path === '/config/ops')
        .map(c => c.body as { expectedRevision?: number; expectedInstance?: string; ops: ConnectConfigOp[] });
    },
  };
  const rev = () => ({ 'X-Config-Revision': String(gw.revision), 'X-Config-Instance': gw.instance });

  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init2) => {
    const u = new URL(typeof url === 'string' ? url : url.toString());
    const path = u.pathname;
    const method = init2?.method ?? 'GET';
    const body = typeof init2?.body === 'string' && init2.body ? JSON.parse(init2.body) : undefined;
    gw.calls.push({ method, path, body });

    if (method === 'GET' && path === '/config/interfaces') return json(gw.interfaces, 200, rev());
    if (method === 'GET' && path === '/config/mirrors') return json(gw.mirrors, 200, rev());
    if (method === 'GET' && path === '/config/mappings') return json(gw.mappings, 200, rev());

    if (path === '/config/ops' && method === 'POST') {
      if (!gw.ops) return json({ error: 'not found' }, 404);
      const fail = gw.failOps.shift();
      if (fail) return json(fail.body, fail.status, rev());
      const req = body as { expectedRevision?: number; expectedInstance?: string; ops: ConnectConfigOp[] };
      if ((req.expectedRevision !== undefined && req.expectedRevision !== gw.revision)
        || (req.expectedInstance !== undefined && req.expectedInstance !== gw.instance)) {
        return json({ code: 'revision-conflict', error: 'changed', revision: gw.revision, instance: gw.instance }, 409, rev());
      }
      const snapshot = structuredClone({ i: gw.interfaces, m: gw.mirrors, p: gw.mappings });
      const results: Record<string, unknown>[] = [];
      const errors: string[] = [];
      req.ops.forEach((op, i) => {
        try { results.push(applyOp(gw, op, i)); } catch (e) { errors.push(`ops[${i}] ${op.op}: ${String(e)}`); results.push({ index: i, op: op.op, outcome: 'error', error: String(e) }); }
      });
      if (errors.length > 0) {
        gw.interfaces = snapshot.i; gw.mirrors = snapshot.m; gw.mappings = snapshot.p;
        return json({ code: 'ops-rejected', error: 'rejected', errors, results, revision: gw.revision, instance: gw.instance }, 400, rev());
      }
      const changed = JSON.stringify(snapshot) !== JSON.stringify({ i: gw.interfaces, m: gw.mirrors, p: gw.mappings });
      if (changed) gw.revision++;
      if (gw.breakOpsBody > 0) {
        gw.breakOpsBody--;
        // The commit happened; the connection drops while the body is read.
        const broken = new ReadableStream<Uint8Array>({ start(c) { c.error(new TypeError('network error')); } });
        return Promise.resolve(new Response(broken, { status: 200, headers: { 'Content-Type': 'application/json', ...rev() } }));
      }
      return json({ outcome: changed ? 'committed' : 'unchanged', revision: gw.revision, instance: gw.instance, results, warnings: [] }, 200, rev());
    }

    if (path === '/config/signals/rename' && method === 'POST') {
      if (!gw.rename) return json({ error: 'not found' }, 404);
      const r = body as { oldName: string; newName: string; preview: boolean; operationId: string | null; renameRevision: string | null };
      const all = gw.interfaces.flatMap(i => [...(i.signals ?? []), ...(i.topics ?? []).flatMap(t => t.signals ?? [])]);
      // Idempotent by operation id (checked first, as SignalRenameOperations does): a repeated apply gets the first outcome.
      const remembered = !r.preview && r.operationId ? gw.renameResults.get(r.operationId) : undefined;
      if (remembered) return json(remembered.body, remembered.status);
      if (all.some(s => s.name === r.newName)) return json({ code: 'name-collision', renameRevision: 'h1' }, 409);
      if (r.preview) {
        return json({ operationId: null, status: 'preview', renameRevision: `h${gw.revision}`, changedInterfaces: [], changedMappings: 0, wireChanges: [], inactiveProfiles: [], storeRenamed: false, liveInGateway: false });
      }
      if (r.renameRevision !== `h${gw.revision}`) {
        const refused = { status: 409, body: { code: 'revision-mismatch', renameRevision: `h${gw.revision}` } };
        if (r.operationId) { gw.renameResults.set(r.operationId, refused); gw.renameStatus.set(r.operationId, 'rejected'); }
        return json(refused.body, refused.status);
      }
      for (const s of all) if (s.name === r.oldName) s.name = r.newName;
      gw.revision++;
      const committed = {
        status: 200,
        body: {
          operationId: r.operationId, status: 'committed', renameRevision: `h${gw.revision}`,
          changedInterfaces: [{ id: gw.interfaces[0]?.id }], changedMappings: 0, wireChanges: [], inactiveProfiles: [],
          storeRenamed: true, liveInGateway: true, storeRevision: gw.revision, instance: gw.instance,
        },
      };
      if (r.operationId) { gw.renameStatus.set(r.operationId, 'committed'); gw.renameResults.set(r.operationId, committed); }
      gw.afterRenameCommit?.();
      if (gw.loseRenameAnswer) { gw.loseRenameAnswer = false; return Promise.reject(new TypeError('Failed to fetch')); }
      return json(committed.body, committed.status);
    }
    if (path.startsWith('/config/signals/rename/') && method === 'GET') {
      const id = decodeURIComponent(path.slice('/config/signals/rename/'.length));
      return json({ status: gw.renameStatus.get(id) ?? 'unknown' });
    }

    if (method === 'PUT' && path.startsWith('/config/interfaces/')) {
      const id = decodeURIComponent(path.slice('/config/interfaces/'.length));
      gw.interfaces = gw.interfaces.map(i => (i.id === id ? structuredClone(body as ConnectInterface) : i));
      gw.revision++;
      return json({ success: true });
    }
    if (method === 'PUT' && path === '/config/mirrors') { gw.mirrors = structuredClone(body); gw.revision++; return json({ success: true }); }
    if (method === 'PUT' && path === '/config/mappings') { gw.mappings = structuredClone(body); gw.revision++; return json({ success: true }); }
    if (path === '/signals/validate') return json({ checked: false, valid: true });
    return json({}, 404);
  });
  return gw;
}
