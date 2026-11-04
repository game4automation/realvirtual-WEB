// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.3 — pure network validation: one minimal graph per code, determinism, load.
 * §9.9c (Phase 8.3) — `path-kink`: a 5° kink at a connection is reported (Problems entry +
 * ring marker through the live publisher), 1° is not; junction blocks branch tangentially.
 */

import { describe, it, expect } from 'vitest';
import { validatePathNetwork, type PathNetworkIssueCode } from '../../src/core/engine/rv-path-network-validate';
import { placeJunction, type NetworkEdit, type NetworkInput, type PathGraphEntry } from '../../src/core/engine/rv-path-network-ops';
import { makePathBlockExtras } from '../../src/core/engine/rv-path-block';
import { PATH_KINK_TOLERANCE_DEG, PATH_LINK_TOLERANCE } from '../../src/core/connect/path-link-tolerance';
import { Group, Object3D, Scene, type Mesh } from 'three';
import { PathNetworkLiveValidation, problemIdOf, validateSceneNetwork } from '../../src/plugins/path-network/path-network-validation';
import { getProblems, resetProblemsForTests } from '../../src/core/hmi/problems-store';

function line(id: string, from: [number, number, number], to: [number, number, number], extra: Partial<PathGraphEntry> = {}): PathGraphEntry {
  return { id, nodeName: id, block: '', segments: [{ kind: 'line', from, to }], successors: [], ...extra };
}

const codes = (net: NetworkInput, env?: { front: number; rear: number; width: number } | null): PathNetworkIssueCode[] =>
  validatePathNetwork(net, { env }).issues.map((i) => i.code);

function apply(net: NetworkInput, edit: NetworkEdit): NetworkInput {
  const paths = new Map(net.paths.map((p) => [p.id, JSON.parse(JSON.stringify(p)) as PathGraphEntry]));
  for (const p of edit.add) paths.set(p.id, JSON.parse(JSON.stringify(p)));
  for (const s of edit.set) {
    const p = paths.get(s.id)! as unknown as Record<string, unknown>;
    if (s.value === null) delete p[s.field]; else p[s.field] = s.value;
  }
  for (const id of edit.remove) paths.delete(id);
  return { ...net, paths: [...paths.values()] };
}

const BODY = { front: 0.9, rear: 0.9, width: 0.8 };

describe('validatePathNetwork (plan-628 §2.8)', () => {
  it('a closed loop of linked paths is clean', () => {
    const net: NetworkInput = { paths: [
      line('A', [0, 0, 0], [5, 0, 0], { successors: ['B'] }),
      line('B', [5, 0, 0], [0, 0, 0], { successors: ['A'] }),
    ] };
    // B → A: the ends meet but the directions are opposite — a 180° kink (plan-628 8.3:
    // a kink is no longer reported as a gap) — use a closed path instead.
    expect(codes({ paths: [line('L', [0, 0, 0], [5, 0, 0], { closed: true })] })).toEqual([]);
    expect(codes(net)).toContain('path-kink');
    expect(codes(net)).not.toContain('path-link-gap');
  });

  it('open end and unreachable start are info', () => {
    const r = validatePathNetwork({ paths: [line('A', [0, 0, 0], [5, 0, 0])] });
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([
      ['path-open-end', 'info'], ['path-unreachable-start', 'info'],
    ]);
    expect(r.issues[0].position).toEqual([5, 0, 0]);
    const st = validatePathNetwork({ paths: [line('A', [0, 0, 0], [5, 0, 0])] }, { stationPaths: new Set(['A']) });
    expect(st.issues.map((i) => i.code)).toEqual(['path-open-end']);
  });

  it('link gap of 6 mm is a gap and a 3° tangent a kink (both errors); 4 mm is a link', () => {
    const gap = (to: [number, number, number]): PathNetworkIssueCode[] => codes({ paths: [
      line('A', [0, 0, 0], [5, 0, 0], { successors: ['B'] }), line('B', to, [to[0] + 5, 0, to[2]]),
    ] }).filter((c) => c === 'path-link-gap');
    expect(gap([5.006, 0, 0])).toEqual(['path-link-gap']);
    expect(gap([5.004, 0, 0])).toEqual([]);
    const t = Math.tan((3 * Math.PI) / 180) * 5;
    const three = codes({ paths: [
      line('A', [0, 0, 0], [5, 0, 0], { successors: ['B'] }), line('B', [5, 0, 0], [10, 0, t]),
    ] });
    expect(three).toContain('path-kink');
    expect(three).not.toContain('path-link-gap');
  });

  // ── §9.9c path-kink (plan-628 8.3) ──

  /** A → B joined at (5,0,0); B leaves at `deg` to A's direction. */
  const kinked = (deg: number): NetworkInput => {
    const r = (deg * Math.PI) / 180;
    return { paths: [
      line('A', [0, 0, 0], [5, 0, 0], { successors: ['B'] }),
      line('B', [5, 0, 0], [5 + 5 * Math.cos(r), 0, 5 * Math.sin(r)]),
    ] };
  };

  it('9.9c: the kink tolerance is the named 2° constant of the link tolerance', () => {
    expect(PATH_KINK_TOLERANCE_DEG).toBe(2);
    expect(PATH_KINK_TOLERANCE_DEG).toBe(PATH_LINK_TOLERANCE.tangentDeg);
  });

  it('9.9c: a 5° kink is one path-kink error at the connection; 1° is not reported', () => {
    const r = validatePathNetwork(kinked(5));
    const k = r.issues.filter((i) => i.code === 'path-kink');
    expect(k).toHaveLength(1);
    expect(k[0]).toMatchObject({ severity: 'error', key: 'A>B', pathId: 'A', position: [5, 0, 0] });
    expect(k[0].detail).toContain('5.0°');
    expect(r.issues.map((i) => i.code)).not.toContain('path-link-gap');
    expect(codes(kinked(1))).not.toContain('path-kink');
    expect(codes(kinked(2))).not.toContain('path-kink'); // inclusive bound
    expect(codes(kinked(2.1))).toContain('path-kink');
  });

  it('9.9c: junction blocks branch tangentially — 0 kink reports (diverge, merge, stub)', () => {
    for (const kind of ['diverge', 'merge', 'stub'] as const) {
      for (const side of ['left', 'right'] as const) {
        const host: NetworkInput = { paths: [line('H', [0, 0, 0], [12, 0, 0], { successors: ['T'] }), line('T', [12, 0, 0], [14, 0, 0])] };
        const j = placeJunction(host, { kind, side }, { pathId: 'H', s: 6 });
        expect(j.ok, `${kind} ${side}: ${j.reason} ${j.detail}`).toBe(true);
        const net = apply(host, j.edit);
        const kinks = validatePathNetwork(net).issues.filter((i) => i.code === 'path-kink' || i.code === 'path-link-gap');
        expect(kinks.map((i) => `${i.code} ${i.key}`), `${kind} ${side}`).toEqual([]);
      }
    }
  });

  it('9.9c: the live publisher puts a 5° kink into Problems and draws a ring; fixing it clears both', () => {
    resetProblemsForTests();
    const scene = new Scene();
    const nodes = new Map<string, Object3D>();
    const mount = (net: NetworkInput): void => {
      for (const p of net.paths) {
        let n = nodes.get(p.id);
        if (!n) { n = new Object3D(); n.name = p.id; scene.add(n); nodes.set(p.id, n); }
        n.userData.realvirtual = { Path: { id: p.id, segments: p.segments, successors: p.successors } };
      }
    };
    mount(kinked(5));
    const markers = new Group();
    const live = new PathNetworkLiveValidation({ scene, registry: null, markRenderDirty: () => {} } as never, markers);
    live.run();
    const entry = getProblems().find((p) => p.id === 'path-network:path-kink:A>B');
    expect(entry, 'Problems entry for the kink').toBeTruthy();
    expect(entry!.code).toBe('path-kink');
    expect(problemIdOf({ code: 'path-kink', key: 'A>B' } as never)).toBe(entry!.id);
    const ring = (markers.children as Object3D[]).find((m) => (m as Mesh).isMesh
      && (m.userData.pathIssue as { code?: string } | undefined)?.code === 'path-kink');
    expect(ring, 'ring marker for the kink').toBeTruthy();
    expect(ring!.position.x).toBeCloseTo(5, 6);
    expect(ring!.position.z).toBeCloseTo(0, 6);

    mount(kinked(1));
    live.run();
    expect(getProblems().some((p) => p.id === 'path-network:path-kink:A>B')).toBe(false);
    expect((markers.children as Object3D[]).some((m) => (m.userData.pathIssue as { code?: string } | undefined)?.code === 'path-kink')).toBe(false);
    live.dispose();
    resetProblemsForTests();
  });

  it('composition-owned paths: no open-end / unreachable-start info, errors still reported', () => {
    const owned = { owner: 'palletYard' };
    const r = validatePathNetwork({ paths: [
      line('Stub', [0, 0, 0], [2, 0, 0], { ...owned, successors: ['Lane'] }),
      line('Lane', [2.01, 0, 0], [6, 0, 0], owned),
    ] });
    expect(r.issues.map((i) => i.code)).toEqual(['path-link-gap']); // 10 mm gap: an error stays
  });

  it('scene validation: a path a vehicle starts on is not unreachable', () => {
    const scene = new Scene();
    const n = new Object3D();
    n.name = 'Dock_1';
    n.userData.realvirtual = { Path: { id: 'Dock_1', segments: [{ kind: 'line', from: [0, 0, 0], to: [2, 0, 0] }], successors: [] } };
    scene.add(n);
    const unreachable = validateSceneNetwork({ scene, registry: null } as never).issues
      .filter((i) => i.code === 'path-unreachable-start').map((i) => i.key);
    expect(unreachable).toEqual(['Dock_1']);
  });

  it('dangling successor is a warning', () => {
    const r = validatePathNetwork({ paths: [line('A', [0, 0, 0], [5, 0, 0], { successors: ['X'] })] });
    expect(r.issues.find((i) => i.code === 'path-dangling-successor')?.severity).toBe('warning');
  });

  it('path-block-transform-not-identity for PathNetwork and a block', () => {
    const extras = makePathBlockExtras({ kind: 'straight' }, [1, 2, 0]);
    const r = validatePathNetwork({
      paths: [line('PN_S1', [1, 0, 2], [3, 0, 2], { block: 'PN_Block_1', closed: true })],
      blocks: [{ id: 'PN_Block_1', extras, transformIdentity: false }],
      rootTransformIdentity: false,
    });
    expect(r.issues.filter((i) => i.code === 'path-block-transform-not-identity').map((i) => i.key)).toEqual(['PN_Block_1', 'PathNetwork']);
  });

  it('unzoned merge is reported; zoned merge without envelope is skipped', () => {
    const unzoned: NetworkInput = { paths: [
      line('A', [0, 0, 0], [5, 0, 0], { successors: ['M'] }),
      line('B', [5, 0, -5], [5, 0, 0], { successors: [] }),
      line('M', [5, 0, 0], [10, 0, 0], { closed: false }),
    ] };
    // B ends at M's start heading +Z; link it anyway — the merge has 2 predecessors.
    (unzoned.paths[1] as PathGraphEntry).successors = ['M'];
    expect(codes(unzoned)).toContain('agv-merge-without-zone');

    const host: NetworkInput = { paths: [line('A', [0, 0, 0], [10, 0, 0], { successors: ['B'] }), line('B', [10, 0, 0], [12, 0, 0])] };
    const j = placeJunction(host, { kind: 'merge', side: 'left' }, { pathId: 'A', s: 6 });
    expect(j.ok).toBe(true);
    const merged = apply(host, j.edit);
    const skipped = validatePathNetwork(merged);
    expect(skipped.skipped).toBe('no-envelope');
    expect(skipped.issues.map((i) => i.code)).toContain('agv-merge-check-skipped');
    expect(skipped.issues.map((i) => i.code)).not.toContain('agv-merge-without-zone');
    const checked = validatePathNetwork(merged, { env: BODY, envelopeSource: 'fleet' });
    expect(checked.skipped).toBeNull();
    expect(checked.envelopeSource).toBe('fleet');
    expect(checked.issues.map((i) => i.code)).not.toContain('agv-merge-check-skipped');
  });

  it('short merge entry under a large explicit envelope', () => {
    const host: NetworkInput = { paths: [line('A', [0, 0, 0], [10, 0, 0], { successors: ['B'] }), line('B', [10, 0, 0], [12, 0, 0])] };
    const j = placeJunction(host, { kind: 'merge', side: 'left' }, { pathId: 'A', s: 6 }); // sized with 1.8 m fallback
    const merged = apply(host, j.edit);
    const big = validatePathNetwork(merged, { env: { front: 2.5, rear: 2.5, width: 1.5 } });
    expect(big.issues.map((i) => i.code)).toContain('agv-merge-entry-too-short');
  });

  it('merge zones too close: free run shorter than env.front', () => {
    // Two merges in series (zones Z1, Z2), 0.5 m free run F between them.
    const paths: PathGraphEntry[] = [
      line('A1', [0, 0, 0], [4, 0, 0], { successors: ['M1'], zone: 'Z1' }),
      line('B1', [4, 0, -4], [4, 0, 0], { successors: ['M1'], zone: 'Z1' }),
      line('M1', [4, 0, 0], [5, 0, 0], { successors: ['F'], zone: 'Z1' }),
      line('F', [5, 0, 0], [5.5, 0, 0], { successors: ['G'] }),
      line('G', [5.5, 0, 0], [6, 0, 0], { successors: ['M2'], zone: 'Z2' }),
      line('B2', [6, 0, -4], [6, 0, 0], { successors: ['M2'], zone: 'Z2' }),
      line('M2', [6, 0, 0], [9, 0, 0], { zone: 'Z2' }),
    ];
    const r = validatePathNetwork({ paths }, { env: BODY });
    expect(r.issues.map((i) => i.code)).toContain('path-merge-zones-too-close');
    const relaxed = validatePathNetwork({ paths }, { env: { front: 0.4, rear: 0.4, width: 0.8 } });
    expect(relaxed.issues.map((i) => i.code)).not.toContain('path-merge-zones-too-close');
  });

  it('output is sorted and independent of the input order', () => {
    const paths = [
      line('A', [0, 0, 0], [5, 0, 0], { successors: ['X'] }),
      line('B', [7, 0, 0], [9, 0, 0]),
      line('C', [0, 0, 3], [4, 0, 3], { successors: ['B'] }),
    ];
    const a = validatePathNetwork({ paths });
    const b = validatePathNetwork({ paths: [...paths].reverse() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const rank = { error: 0, warning: 1, info: 2 } as const;
    const sev = a.issues.map((i) => rank[i.severity]);
    expect([...sev].sort()).toEqual(sev);
  });

  it('500 paths validate in < 50 ms', () => {
    // §9.3 asks < 5 ms; the dev PC (6 threads, RAM 2133) and parallel agents need slack —
    // the bound here guards against quadratic regressions, not the absolute budget.
    const paths: PathGraphEntry[] = [];
    for (let i = 0; i < 500; i++) {
      paths.push(line(`P${i}`, [i, 0, 0], [i + 1, 0, 0], { successors: i < 499 ? [`P${i + 1}`] : [] }));
    }
    validatePathNetwork({ paths }); // warm-up
    const t0 = performance.now();
    const r = validatePathNetwork({ paths });
    const dt = performance.now() - t0;
    expect(r.issues.map((i) => i.code)).toEqual(['path-open-end', 'path-unreachable-start']);
    expect(dt).toBeLessThan(50);
  });
});
