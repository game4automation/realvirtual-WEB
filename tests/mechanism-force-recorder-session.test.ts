// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-706 T7 / T8 / T9 / T10 / T2b — forces, statics and the session coupling.
 *
 * **T9 is the mandatory proof of this plan.** Before it, the "recording follows
 * the test session" rule lived in a React `useEffect` inside a component that is
 * rendered only in the EXPANDED Mechanism row. A session started any other way —
 * the toolbar with the panel closed, or an agent through `web_editor_test_start`
 * — recorded nothing at all, so the whole build → test → size cycle ended with
 * empty figures and no error to explain them. This file renders NO React and
 * asserts recording starts anyway.
 *
 * T2b is the counterpart of `mechanism-mcp-inspect.test.ts`'s T2: sixteen tools
 * refuse without the private bundle, and these two deliberately do NOT — the
 * test session does not depend on a solver, and turning it into an error would
 * disable precisely the tools that make F13 observable.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group } from 'three';
import type { Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { McpEditorTools } from '../src/plugins/mcp-bridge/rv-mcp-editor-tools';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import {
  MechanismForceRecorder,
  MechanismForceRecorderPlugin,
  MECHANISM_FORCE_RECORDER_ID,
  ensureForceRecorder,
} from '../src/plugins/mechanism-force-recorder-plugin';
import { setActiveTestSession } from '@rv-private/plugins/asset-editor/test-session-store';
import type { InPlaceTestSession, TestSessionState } from '@rv-private/plugins/asset-editor/in-place-test-session';
import {
  setMechanismUiBridge,
  type MechanismForcesSnapshot,
  type MechanismUiBridge,
  type MechanismView,
} from '../src/core/engine/rv-kinematic-registry';

// ─── Doubles ────────────────────────────────────────────────────────────────

/** A session whose state can be driven by hand, with the store's relay wired. */
class FakeSession {
  state: TestSessionState = 'idle';
  private readonly _listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this._listeners.add(fn);
    return () => { this._listeners.delete(fn); };
  };

  async start(): Promise<void> { this._set('running'); }
  async stop(): Promise<void> { this._set('idle'); }

  private _set(next: TestSessionState): void {
    this.state = next;
    for (const fn of this._listeners) fn();
  }
}

function snapshot(mechanismPath: string, value = 0): MechanismForcesSnapshot {
  return {
    mechanismPath, status: 0, statusText: 'Ok', dynamicsValid: true, redundant: false,
    channels: [
      { id: `${mechanismPath}|dof0`, label: 'Axis 1', kind: 'drive', unit: 'N·m', value, linkPath: `${mechanismPath}/Arm` },
      { id: `${mechanismPath}|joint0|F`, label: 'Joint 1 F', kind: 'joint-force', unit: 'N', value: 12, linkPath: `${mechanismPath}/Arm` },
    ],
    joints: [{
      jointPath: `${mechanismPath}/Joint1`, name: 'Joint1',
      forceWorld: [1, 2, 3], torqueWorld: [4, 5, 6],
      originWorld: [0, 0, 0], axisWorld: [0, 0, 1],
    }],
  };
}

class FakeBridge implements MechanismUiBridge {
  armed = new Map<string, boolean>();
  jogCalls = 0;
  solveCalls = 0;
  staticsCalls = 0;
  resetCalls = 0;
  current = 0;

  constructor(readonly paths: string[] = ['Mech']) {}

  list(): MechanismView[] {
    return this.paths.map((nodePath) => ({
      nodePath, name: nodePath, active: true, converged: true, residualError: 0,
      solveTimeMs: 0, disabledReason: '', jointCount: 1, linkCount: 1, loopCount: 0, dof: 1,
      joints: [], links: [], findings: [],
    }));
  }
  validate() { return []; }
  jog() { this.jogCalls++; return { converged: true, residualError: 0 }; }
  solve() { this.solveCalls++; return { converged: true, residualError: 0 }; }
  rebuild(): void {}
  suggestFix(): null { return null; }
  setForceAnalysis(path: string, enabled: boolean): void { this.armed.set(path, enabled); }
  forcesSnapshot(path: string): MechanismForcesSnapshot | null {
    return this.paths.includes(path) ? snapshot(path, this.current) : null;
  }
  solveStatics(path: string): MechanismForcesSnapshot | null {
    this.staticsCalls++;
    return this.paths.includes(path) ? snapshot(path, 95) : null;
  }
  resetForces(): void { this.resetCalls++; }
  linkNodes(): { path: string; node: Object3D }[] { return []; }
}

// ─── Fixture ────────────────────────────────────────────────────────────────

interface Env {
  viewer: RVViewer;
  doc: AssetDocument;
  tools: McpEditorTools;
  plugins: Map<string, unknown>;
}

function makeEnv(): Env {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Mech';
  scene.add(root);
  const registry = new NodeRegistry();
  registry.registerNode('Mech', root);

  const plugins = new Map<string, unknown>();
  let activeMode = 'editor';
  const viewer = {
    scene, registry, signalStore: null, transportManager: null,
    get currentModelRoot() { return root; },
    modes: {
      get activeMode() { return activeMode; },
      has: () => true, setMode: (m: string) => { activeMode = m; },
      list: () => [{ id: 'editor' }], subscribe: () => () => {},
    },
    selectionManager: {
      select() {}, selectPaths() {}, clear() {},
      getSnapshot: () => ({ selectedPaths: [] as string[] }),
    },
    getPlugin<T>(id: string): T | undefined { return plugins.get(id) as T | undefined; },
    use(plugin: { id: string; init?: (v: RVViewer) => void }): void {
      plugins.set(plugin.id, plugin);
      plugin.init?.(viewer);
    },
    markRenderDirty() {}, markShadowsDirty() {}, emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {}, refitRaycastSubtrees() {},
  } as unknown as RVViewer;

  const doc = scratchAssetDocument(viewer);
  setActiveAssetContext({ viewer, doc });
  return { viewer, doc, tools: new McpEditorTools(() => viewer), plugins };
}

let env: Env;

beforeEach(async () => {
  await __clearDraftStoresForTests();
  env = makeEnv();
});

afterEach(() => {
  setActiveTestSession(null);
  setMechanismUiBridge(null);
  setActiveAssetContext(null);
  env.doc.dispose();
});

const parse = (json: string): Record<string, any> => JSON.parse(json) as Record<string, any>;

// ─── T7 — the three sizing figures ──────────────────────────────────────────

describe('T7 — peak, RMS and holding per channel', () => {
  it('a ±340 N square wave at 50 % duty gives peak 340 and RMS 340·√0.5', () => {
    const recorder = new MechanismForceRecorder();
    recorder.start();
    // 10 Hz, 200 samples: |value| is 340 for half of them and 0 for the rest.
    for (let i = 0; i < 200; i++) {
      const value = i % 2 === 0 ? 340 : 0;
      recorder.sample(0.1, () => [{
        ...snapshot('Mech'),
        channels: [{ id: 'ch', label: 'Axis', kind: 'drive', unit: 'N·m', value, linkPath: null }],
      }]);
    }
    const m = recorder.metrics('ch');
    expect(m.peak).toBe(340);
    expect(m.rms).toBeGreaterThan(340 * Math.SQRT1_2 * 0.98);
    expect(m.rms).toBeLessThan(340 * Math.SQRT1_2 * 1.02);
    expect(m.sampleCount).toBeGreaterThan(150);
    // Holding is NEVER guessed from a dynamic zero crossing.
    expect(m.holding).toBeNull();
  });

  it('holding appears only after it is filed', () => {
    const recorder = new MechanismForceRecorder();
    recorder.start();
    recorder.sample(0.2, () => [{
      ...snapshot('Mech'),
      channels: [{ id: 'ch', label: 'Axis', kind: 'drive', unit: 'N·m', value: 10, linkPath: null }],
    }]);
    expect(recorder.metrics('ch').holding).toBeNull();
    recorder.setHolding('ch', -95);
    expect(recorder.metrics('ch').holding).toBe(95); // magnitude, sign-free
  });

  it('web_editor_mechanism_forces reports the figures with their unit', async () => {
    setMechanismUiBridge(new FakeBridge());
    const plugin = ensureForceRecorder(env.viewer);
    plugin.start();
    for (let i = 0; i < 40; i++) plugin.onFixedUpdatePost(0.1);

    const r = parse(await env.tools.webEditorMechanismForces('Mech', '', false));
    expect(r.error).toBeUndefined();
    expect(r.dynamicsValid).toBe(true);
    expect(r.channels).toHaveLength(2);
    for (const c of r.channels) {
      expect(c).toHaveProperty('peak');
      expect(c).toHaveProperty('rms');
      expect(c).toHaveProperty('holding');
      expect(c).toHaveProperty('sampleCount');
      expect(['N', 'N·m']).toContain(c.unit);
    }
    // The world wrench travels too, for an external load-path analysis.
    expect(r.joints[0].forceWorld).toEqual([1, 2, 3]);
    expect(r.joints[0].torqueWorld).toEqual([4, 5, 6]);
  });

  it('series=true without a channelId says so instead of guessing one', async () => {
    setMechanismUiBridge(new FakeBridge());
    const r = parse(await env.tools.webEditorMechanismForces('Mech', '', true));
    expect(r.seriesNote).toContain('channelId');
    for (const c of r.channels) expect(c.series).toBeUndefined();
  });

  it('series=true with a channelId returns a capped series for THAT channel only', async () => {
    setMechanismUiBridge(new FakeBridge());
    const plugin = ensureForceRecorder(env.viewer);
    plugin.start();
    for (let i = 0; i < 60; i++) plugin.onFixedUpdatePost(0.1);

    const id = 'Mech|dof0';
    const r = parse(await env.tools.webEditorMechanismForces('Mech', id, true));
    const target = r.channels.find((c: Record<string, unknown>) => c.id === id);
    expect(target.series).toBeDefined();
    expect(target.series.values.length).toBeLessThanOrEqual(200);
    expect(typeof target.series.dt).toBe('number');
    const other = r.channels.find((c: Record<string, unknown>) => c.id !== id);
    expect(other.series).toBeUndefined();
  });

  it('an unknown mechanism names the ones that exist', async () => {
    setMechanismUiBridge(new FakeBridge());
    const r = parse(await env.tools.webEditorMechanismForces('Nope', '', false));
    expect(r.error).toContain('Nope');
    expect(r.availablePaths).toEqual(['Mech']);
  });
});

// ─── T8 — statics ───────────────────────────────────────────────────────────

describe('T8 — statics fills holding without moving the pose', () => {
  it('solveStatics once, jog never, and every channel gets its holding figure', async () => {
    const bridge = new FakeBridge();
    setMechanismUiBridge(bridge);
    const r = parse(await env.tools.webEditorMechanismStatics('Mech'));

    expect(r.error).toBeUndefined();
    expect(bridge.staticsCalls).toBe(1);
    // A statics run answers "what does it take to hold this HERE" — moving the
    // mechanism to find out would answer a different question.
    expect(bridge.jogCalls).toBe(0);

    // EVERY channel of the statics run is filed, each with its own magnitude —
    // the drive figure and the bearing load are different numbers and must not
    // be collapsed into one.
    const recorder = ensureForceRecorder(env.viewer).recorder;
    expect(r.channels.length).toBeGreaterThan(1);
    for (const c of r.channels) {
      expect(recorder.metrics(c.id).holding).toBe(Math.abs(c.value));
      expect(c.holding).toBe(Math.abs(c.value));
    }
    expect(r.channels.find((c: Record<string, unknown>) => c.kind === 'drive').holding).toBe(95);
  });

  it('an unsolvable mechanism points at the likely cause', async () => {
    setMechanismUiBridge(new FakeBridge());
    const r = parse(await env.tools.webEditorMechanismStatics('Nope'));
    expect(r.error).toContain('add_body');
  });
});

// ─── T9 — THE proof: recording without a rendered panel ─────────────────────

describe('T9 — an MCP-started test session records forces with NO panel', () => {
  it('web_editor_test_start records, web_editor_test_stop ends it', async () => {
    const bridge = new FakeBridge();
    setMechanismUiBridge(bridge);
    const session = new FakeSession();
    setActiveTestSession(session as unknown as InPlaceTestSession);

    // No React is rendered anywhere in this test — that IS the assertion.
    const started = parse(await env.tools.webEditorTestStart());
    expect(started.ok).toBe(true);
    expect(started.state).toBe('running');
    expect(started.forceRecording).toBe(true);

    const plugin = env.plugins.get(MECHANISM_FORCE_RECORDER_ID) as MechanismForceRecorderPlugin;
    expect(plugin.recorder.recording).toBe(true);
    // Arming the private analysis is part of it: an unarmed mechanism reports
    // "Disabled" forever, which looks exactly like "no load".
    expect(bridge.armed.get('Mech')).toBe(true);

    const stopped = parse(await env.tools.webEditorTestStop());
    expect(stopped.state).toBe('idle');
    expect(stopped.forceRecording).toBe(false);
    expect(plugin.recorder.recording).toBe(false);
    expect(bridge.armed.get('Mech')).toBe(false);
  });

  it('the buffers SURVIVE the stop — the cycle is read afterwards', async () => {
    setMechanismUiBridge(new FakeBridge());
    const session = new FakeSession();
    setActiveTestSession(session as unknown as InPlaceTestSession);

    await env.tools.webEditorTestStart();
    const plugin = env.plugins.get(MECHANISM_FORCE_RECORDER_ID) as MechanismForceRecorderPlugin;
    for (let i = 0; i < 30; i++) plugin.onFixedUpdatePost(0.1);
    await env.tools.webEditorTestStop();

    const r = parse(await env.tools.webEditorMechanismForces('Mech', '', false));
    expect(r.channels[0].sampleCount).toBeGreaterThan(0);
  });

  it('a session that goes running WITHOUT the tool records too — one trigger, not two', async () => {
    setMechanismUiBridge(new FakeBridge());
    const plugin = ensureForceRecorder(env.viewer);
    const session = new FakeSession();
    setActiveTestSession(session as unknown as InPlaceTestSession);
    expect(plugin.recorder.recording).toBe(false);

    // The toolbar button's path: the session simply transitions.
    await session.start();
    expect(plugin.recorder.recording).toBe(true);
    await session.stop();
    expect(plugin.recorder.recording).toBe(false);
  });

  it('converges with the session\'s OWN recordForces call instead of fighting it', async () => {
    // `InPlaceTestSession` starts the recorder directly too (the "the test run
    // owns force recording" fix). Both express the same rule, so the second one
    // to arrive must do nothing — starting an already-open window would clear
    // the samples the first one just began collecting.
    setMechanismUiBridge(new FakeBridge());
    const plugin = ensureForceRecorder(env.viewer);
    const session = new FakeSession();
    setActiveTestSession(session as unknown as InPlaceTestSession);

    plugin.start();                       // stands in for the session's direct call
    for (let i = 0; i < 20; i++) plugin.onFixedUpdatePost(0.1);
    const elapsed = plugin.recorder.elapsed;
    expect(elapsed).toBeGreaterThan(0);

    await session.start();                // the store transition arrives second
    expect(plugin.recorder.recording).toBe(true);
    expect(plugin.recorder.elapsed, 'the open window must not be wiped').toBe(elapsed);
  });

  it('staying `running` does not restart the window', async () => {
    setMechanismUiBridge(new FakeBridge());
    const plugin = ensureForceRecorder(env.viewer);
    const session = new FakeSession();
    setActiveTestSession(session as unknown as InPlaceTestSession);
    await session.start();
    for (let i = 0; i < 20; i++) plugin.onFixedUpdatePost(0.1);
    const elapsed = plugin.recorder.elapsed;

    // A re-notification at the same state must not clear the buffers; doing so
    // on every store bump is indistinguishable from never recording.
    await session.start();
    expect(plugin.recorder.elapsed).toBe(elapsed);
  });
});

// ─── T10 — the manual toggle survives the move ──────────────────────────────

describe('T10 — the panel\'s manual toggle still works', () => {
  it('a manual start records, and a later session stop ends it', async () => {
    setMechanismUiBridge(new FakeBridge());
    const plugin = ensureForceRecorder(env.viewer);
    const session = new FakeSession();
    setActiveTestSession(session as unknown as InPlaceTestSession);

    plugin.start(); // what the panel's record button calls
    expect(plugin.recorder.recording).toBe(true);

    // The session stays the STRONGER source, exactly as before the move.
    await session.start();
    await session.stop();
    expect(plugin.recorder.recording).toBe(false);
  });

  it('a manual stop is not undone by an unrelated store notification', () => {
    setMechanismUiBridge(new FakeBridge());
    const plugin = ensureForceRecorder(env.viewer);
    plugin.start();
    plugin.stop();
    setActiveTestSession(null); // bumps the store
    expect(plugin.recorder.recording).toBe(false);
  });
});

// ─── T2b — the two deliberate bridge exceptions ─────────────────────────────

describe('T2b — test_start/_stop stay usable WITHOUT the private bundle', () => {
  it('both answer ok with forceRecording:false and NO error', async () => {
    setMechanismUiBridge(null);
    const session = new FakeSession();
    setActiveTestSession(session as unknown as InPlaceTestSession);

    const started = parse(await env.tools.webEditorTestStart());
    expect(started.error).toBeUndefined();
    expect(started.ok).toBe(true);
    expect(started.state).toBe('running');
    // Honest, not an error: the session ran, there is simply no solver to
    // record forces from.
    expect(started.forceRecording).toBe(false);

    const stopped = parse(await env.tools.webEditorTestStop());
    expect(stopped.error).toBeUndefined();
    expect(stopped.ok).toBe(true);
    expect(stopped.forceRecording).toBe(false);
  });

  it('with no session at all they say what to do', async () => {
    setActiveTestSession(null);
    const r = parse(await env.tools.webEditorTestStart());
    expect(r.error).toContain('web_editor_open');
  });

  it('web_editor_status carries the session state — no 19th tool for one enum', async () => {
    const session = new FakeSession();
    setActiveTestSession(session as unknown as InPlaceTestSession);
    expect(parse(await env.tools.webEditorStatus()).testSession).toBe('idle');
    await session.start();
    expect(parse(await env.tools.webEditorStatus()).testSession).toBe('running');
  });
});
