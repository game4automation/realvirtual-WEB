// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * custom-connection-call.test.ts — plan-259 §9.6 (QuickJS e2e).
 *
 * User-defined connection type (`connectionTypes` signature) between two
 * script components: `self.connection(type).call(params, onReply)` →
 * `onRequest(topic, params, reply)` → deferred `reply(response)` reaches the
 * sender. Parameter/response validation against the signature, duplicate
 * reply no-op, reply invalidated after reset.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import {
  RVConnectionRegistry,
  __setConnectionSystemForTests,
  getConnectionSystem,
  type ConnectionReplyFn,
} from '../src/core/engine/rv-connection-registry';
import { RV_CONN_REQ_HOOK } from '../src/core/sdk/rv-script-hook';
import { RVScriptHost } from '../src/core/engine/rv-script-host';
import { RVWebComponentRegistry, parseWebComponent } from '../src/core/engine/rv-web-component-registry';

const dt = 1 / 60;

const SENDER_CODE = `
function setup(self) {
  return {
    onMessage: function (topic) {
      if (topic !== 'go') return;
      var n = self.connection('QualityCheck').call({ partId: 42, imageRef: 'img://x' }, function (resp) {
        self.signal('QC.Pass').set(resp.pass === true);
        self.signal('QC.Defects').set(resp.defects);
        self.setState('replied');
      });
      self.signal('QC.Delivered').set(n);
    },
  };
}
`;

const RECEIVER_CODE = `
function setup(self) {
  return {
    onRequest: function (topic, params, reply) {
      self.setState('inspecting:' + params.partId);
      // Deferred reply (no Promise): answer 0.2 s later via the event heap.
      self.in(0.2, 'inspected', null, null);
      globalThis.__reply = reply;
    },
    des: { on: function (hook) {
      if (hook === 'inspected') {
        globalThis.__reply({ pass: true, defects: 0, extra: 'kept' });
        globalThis.__reply({ pass: false });  // duplicate → must be ignored
      }
    } },
  };
}
`;

interface Rig {
  scripts: RVWebComponentRegistry;
  signals: Map<string, boolean | number>;
  states: string[];
  tick(n: number): void;
  send(topic: string): void;
  dispose(): void;
}

async function buildRig(host: RVScriptHost): Promise<Rig> {
  const conn = getConnectionSystem();
  conn.loadModel({
    connections: [{ id: 'c1', source: 'Cell/CamA', target: 'Cell/Analyzer', type: 'QualityCheck' }],
    connectionTypes: [{
      type: 'QualityCheck',
      request: { partId: 'int', imageRef: 'string' },
      response: { pass: 'bool', defects: 'int' },
    }],
  });

  const signals = new Map<string, boolean | number>();
  const states: string[] = [];

  const scripts = new RVWebComponentRegistry({
    host,
    callDeadlineMs: 200,
    buildEnv: ({ nodePath, nodeName, node, props, scheduler, addTeardown }) => {
      // Target side: schedule the request on the instance's own event list —
      // exactly the web-component plugin's endpoint wiring.
      const replyFns = new Map<number, ConnectionReplyFn>();
      let nextReplyId = 1;
      addTeardown(conn.registerEndpoint(nodePath, {
        onRequest: (topic, params, reply) => {
          const replyId = nextReplyId++;
          replyFns.set(replyId, reply);
          scheduler.in(0, RV_CONN_REQ_HOOK, null, { topic, params, replyId });
        },
      }));
      return {
        name: nodeName, path: nodePath, node, props, scheduler,
        connections: {
          call: (type, params, onReply) => conn.call(nodePath, type, params, onReply),
          reply: (replyId, response) => {
            const fn = replyFns.get(replyId);
            if (!fn) return;
            replyFns.delete(replyId);
            fn(response);
          },
        },
        signals: {
          get: (n) => signals.get(n),
          set: (n, v) => signals.set(n, v),
        },
        onSetState: (s) => states.push(`${nodeName}:${s}`),
        log: () => {},
      };
    },
  });

  const camNode = new Object3D(); camNode.name = 'CamA';
  const anaNode = new Object3D(); anaNode.name = 'Analyzer';
  scripts.create('Cell/CamA', camNode, parseWebComponent({ Code: SENDER_CODE })!);
  scripts.create('Cell/Analyzer', anaNode, parseWebComponent({ Code: RECEIVER_CODE })!);

  return {
    scripts, signals, states,
    tick(n: number) { for (let i = 0; i < n; i++) scripts.tickAll(dt); },
    send(topic: string) { scripts.sendMessage('test', 'Cell/CamA', topic, null); },
    dispose() { scripts.dispose(); },
  };
}

let host: RVScriptHost;

describe('custom connection call (plan-259 Stufe 2)', () => {
  beforeEach(() => {
    __setConnectionSystemForTests(new RVConnectionRegistry());
  });

  afterEach(() => {
    __setConnectionSystemForTests(null);
  });

  it('call → onRequest → deferred reply reaches the sender; duplicate reply ignored', async () => {
    host = host ?? await RVScriptHost.create();
    const rig = await buildRig(host);
    try {
      rig.send('go');
      rig.tick(3); // deliver message + request
      expect(rig.signals.get('QC.Delivered')).toBe(1);
      expect(rig.states).toContain('Analyzer:inspecting:42');
      expect(rig.signals.get('QC.Pass')).toBeUndefined(); // reply is DEFERRED

      rig.tick(20); // 0.2 s pass on the receiver's event heap
      expect(rig.signals.get('QC.Pass')).toBe(true);
      expect(rig.signals.get('QC.Defects')).toBe(0);
      // Duplicate reply ignored → the pass=false answer never overwrote it.
      expect(rig.states.filter((s) => s === 'CamA:replied')).toHaveLength(1);
      expect(getConnectionSystem().openReplyCount).toBe(0);
    } finally {
      rig.dispose();
    }
  });

  it('validates request parameters against the signature (missing/mismatch → defaults)', async () => {
    host = host ?? await RVScriptHost.create();
    const conn = getConnectionSystem();
    conn.loadModel({
      connections: [{ id: 'c1', source: 'A', target: 'B', type: 'QC' }],
      connectionTypes: [{ type: 'QC', request: { partId: 'int', imageRef: 'string' } }],
    });
    const seen: Array<Record<string, unknown>> = [];
    conn.registerEndpoint('B', { onRequest: (_t, params) => seen.push(params) });
    conn.call('A', 'QC', { partId: 'not-a-number' }, null);
    expect(seen).toEqual([{ partId: 0, imageRef: '' }]);
  });

  it('reply after resetRuntime is invalidated (no ghost call)', async () => {
    const conn = getConnectionSystem();
    conn.loadModel({
      connections: [{ id: 'c1', source: 'A', target: 'B', type: 'QC' }],
      connectionTypes: [{ type: 'QC' }],
    });
    let heldReply: ((r: unknown) => void) | null = null;
    conn.registerEndpoint('B', { onRequest: (_t, _p, reply) => { heldReply = reply; } });
    const replies: unknown[] = [];
    conn.call('A', 'QC', {}, (r) => replies.push(r));
    expect(conn.openReplyCount).toBe(1);

    conn.resetRuntime(); // sim reset — the handle dies
    heldReply!({ pass: true });
    expect(replies).toHaveLength(0);
    expect(conn.openReplyCount).toBe(0);
  });

  it('fan-out 1:n — onReply fires once per replying target', async () => {
    const conn = getConnectionSystem();
    conn.loadModel({
      connections: [
        { id: 'c1', source: 'A', target: 'B1', type: 'QC' },
        { id: 'c2', source: 'A', target: 'B2', type: 'QC' },
      ],
      connectionTypes: [{ type: 'QC' }],
    });
    conn.registerEndpoint('B1', { onRequest: (_t, _p, reply) => reply({ from: 'B1' }) });
    conn.registerEndpoint('B2', { onRequest: (_t, _p, reply) => reply({ from: 'B2' }) });
    const replies: Array<Record<string, unknown>> = [];
    const n = conn.call('A', 'QC', {}, (r) => replies.push(r));
    expect(n).toBe(2);
    expect(replies.map((r) => r.from).sort()).toEqual(['B1', 'B2']);
  });
});
