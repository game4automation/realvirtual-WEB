// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 F6 / D8 / R5 — the trust gate of a PLACED asset, wired at one point
 * (`integratePlacedContent`) and read from the asset's OWN signature state
 * (`BakedAsset.signatureState`), never inherited from the document.
 *
 * The rule is `isFrameGated` (plan-397 §2.9) applied to (asset, document):
 * a broken signature gates, a signed document gates an unsigned asset, an
 * unsigned document takes nothing away, the user's release overrides all.
 *
 * What the fixtures can and cannot show: a `'valid'` state needs the private
 * root key, which no test has — so the "signed document + unsigned asset" case
 * of the plan is pinned on the RULE (table below), while the two live cases use
 * a BROKEN signature (`rv_sig` present, verification fails → `invalid`, or
 * `unverifiable` where WebCrypto lacks Ed25519), which gates exactly like a
 * signed root does for an unsigned frame:
 *
 *  (1) unsigned document + broken asset → the ASSET is gated: its drives are
 *      constructed and registered, its LogicSteps never enter the engine, its
 *      drive does not move after n steps, the Problems panel carries
 *      `logic-gated` — and the document's own logic state is untouched;
 *  (2) broken document + unsigned asset → the DOCUMENT is gated and placing an
 *      unsigned asset does not release it (trust is not lent upwards); the
 *      asset's logic is deferred with the document's and runs once the user
 *      activates the gate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import { RV_SIG_PLACEHOLDER } from '../src/core/persistence/rv-sig-verify';
import { parseGlbChunks, rebuildGlbWithJson, ensureDefaultSceneExtras } from '../src/core/persistence/rv-glb-chunks';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { isPlacedAssetGated, isPlacedChainGated } from '../src/core/engine/rv-placement-integrate';
import type { SignatureState } from '../src/core/persistence/rv-sig-verify';
import { parityFixture } from './fixtures/parity-fixtures';
import { nestedParityFixture } from './fixtures/parity-nested-fixtures';
import {
  createParityHost, fixtureBytes, loadAsSinglePlacement, snapshot, snapshotAfter, type ParityHost,
} from './helpers/parity-harness';

/** Stamp a syntactically valid, cryptographically wrong `rv_sig` into the default scene's extras. */
function withBrokenSignature(bytes: ArrayBuffer): ArrayBuffer {
  const chunks = parseGlbChunks(bytes);
  const extras = ensureDefaultSceneExtras(chunks.json as Record<string, unknown>);
  extras.rv_sig = RV_SIG_PLACEHOLDER;
  const out = rebuildGlbWithJson(chunks);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

const BROKEN: ReadonlyArray<SignatureState> = ['invalid', 'unverifiable'];
const STATES: ReadonlyArray<SignatureState> = ['none', 'valid', 'invalid', 'unverifiable'];

describe('the rule — isPlacedAssetGated(asset, document, allowUntrustedLogic)', () => {
  it('a broken asset is gated in any document; a signed document gates an unsigned asset; nothing else gates', () => {
    for (const doc of STATES) {
      expect(isPlacedAssetGated('invalid', doc, false), `invalid in ${doc}`).toBe(true);
      expect(isPlacedAssetGated('unverifiable', doc, false), `unverifiable in ${doc}`).toBe(true);
      expect(isPlacedAssetGated('valid', doc, false), `valid in ${doc}`).toBe(false);
    }
    // The plan's headline case: signed document + unsigned asset → gated (D8:
    // the document's trust is not lent to the asset).
    expect(isPlacedAssetGated('none', 'valid', false)).toBe(true);
    // An unsigned document takes nothing away — the whole existing corpus.
    expect(isPlacedAssetGated('none', 'none', false)).toBe(false);
    // A broken DOCUMENT does not gate a sound asset through this rule — the
    // document's own gate (`logicRunState`) holds everything anyway.
    expect(isPlacedAssetGated('none', 'invalid', false)).toBe(false);
  });

  it('the user\'s explicit release overrides every combination', () => {
    for (const asset of STATES) for (const doc of STATES) expect(isPlacedAssetGated(asset, doc, true)).toBe(false);
  });
});

describe('(1) unsigned document + broken asset → the asset is gated, the document is not', () => {
  let host: ParityHost;
  let placementRoot: Object3D;
  let rootPath: string;
  let loaded: Awaited<ReturnType<typeof loadAsSinglePlacement>>;
  beforeAll(async () => {
    resetProblemsForTests();
    host = await createParityHost();
    const fixture = parityFixture('g'); // Cell: Slide (Drive) + Seq (LogicStep_SerialContainer → Up/Down)
    const bytes = withBrokenSignature(await fixtureBytes(fixture.build()));
    loaded = await loadAsSinglePlacement(host, bytes, fixture.rootName);
    placementRoot = loaded.assetRoot;
    rootPath = loaded.rootPath;
  }, 120_000);
  afterAll(() => { loaded?.release(); host?.dispose(); resetProblemsForTests(); });

  it('the asset carries its OWN broken verdict; the document stays active', () => {
    expect(BROKEN).toContain(loaded.baked!.signatureState);
    expect(host.viewer.getSignatureState()).toBe('none');
    expect(host.viewer.logicRunState).toBe('active');
  });

  it('drives are constructed and registered, the LogicSteps never enter the engine', () => {
    const snap = snapshot(loaded);
    expect(snap.nodes['Slide']?.components).toContain('Drive');
    expect(Object.keys(snap.nodes)).toEqual(expect.arrayContaining(['Seq', 'Seq/Up', 'Seq/Down']));
    // The geometry is there — a gated asset is visible, not missing.
    expect(snap.counts.chunkMeshes).toBeGreaterThan(0);
    // …but no LogicStep root of this placement is in the engine.
    expect(Object.keys(snap.logic)).toEqual([]);
  });

  it('after n fixed steps the gated drive has not moved', () => {
    const after = snapshotAfter(loaded, 60);
    expect(after.drives['Slide']).toBe(0);
    expect(after.steps).toEqual({});
  });

  it('the Problems panel names the placement as logic-gated', () => {
    const gated = getProblems().filter((p) => p.code === 'logic-gated');
    expect(gated).toHaveLength(1);
    expect(gated[0].nodePath).toBe(rootPath);
    expect(gated[0].id).toBe(`logic-gated:${rootPath}`);
    expect(gated[0].detail).toMatch(/invalid|unverifiable/);
    expect(gated[0].severity).toBe('warning');
    void placementRoot;
  });
});

describe('(2) broken document + unsigned asset → the document is gated and the asset does not release it', () => {
  let host: ParityHost;
  let loaded: Awaited<ReturnType<typeof loadAsSinglePlacement>>;
  beforeAll(async () => {
    resetProblemsForTests();
    host = await createParityHost();
    const fixture = parityFixture('g');
    loaded = await loadAsSinglePlacement(host, await fixtureBytes(fixture.build()), fixture.rootName, {
      documentBytes: withBrokenSignature,
    });
  }, 120_000);
  afterAll(() => { loaded?.release(); host?.dispose(); resetProblemsForTests(); });

  it('the document is gated by its own signature and placing an unsigned asset does not unlock it', () => {
    expect(BROKEN).toContain(host.viewer.getSignatureState());
    expect(host.viewer.logicRunState).toBe('gated');
    expect(loaded.baked!.signatureState).toBe('none');
    // Not the ASSET's gate: no `logic-gated` problem — the hold is the document's.
    expect(getProblems().filter((p) => p.code === 'logic-gated')).toEqual([]);
  });

  it('nothing moves while the document is gated; the user\'s release starts the placed logic too', async () => {
    expect(snapshotAfter(loaded, 30).drives['Slide']).toBe(0);
    await expect(host.viewer.activateGatedLogic()).resolves.toBe(true);
    expect(host.viewer.logicRunState).toBe('active');
    const snap = snapshot(loaded);
    expect(Object.keys(snap.logic)).toContain('Seq');
    const after = snapshotAfter(loaded, 60);
    expect(after.drives['Slide']).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// plan-757 Phase 2 (F7) — the chain above a nested placement lends nothing
// ═══════════════════════════════════════════════════════════════════════

describe('the chain rule — isPlacedChainGated(chain, asset, document, allowUntrustedLogic) (plan-757 F7)', () => {
  it('signed document → unsigned outer → signed inner: the inner is gated (the chain takes away, never lends)', () => {
    // The plan's three cases, as the rule: chain = the containing assets' weakest verdict.
    expect(isPlacedChainGated('none', 'valid', 'valid', false)).toBe(true);
    // A broken outer gates a sound inner in ANY document.
    for (const doc of STATES) {
      expect(isPlacedChainGated('invalid', 'valid', doc, false), `invalid chain in ${doc}`).toBe(true);
      expect(isPlacedChainGated('unverifiable', 'none', doc, false), `unverifiable chain in ${doc}`).toBe(true);
    }
    // A signed outer does not lift an unsigned inner in a signed document either.
    expect(isPlacedChainGated('valid', 'none', 'valid', false)).toBe(true);
  });

  it('unsigned document: the chain changes nothing that was not gated before (the whole existing corpus)', () => {
    expect(isPlacedChainGated('none', 'none', 'none', false)).toBe(false);
    expect(isPlacedChainGated('valid', 'valid', 'none', false)).toBe(false);
    // A broken DOCUMENT is not this rule's business (the document's own gate holds everything).
    expect(isPlacedChainGated('none', 'none', 'invalid', false)).toBe(false);
  });

  it("NO chain (undefined) IS isPlacedAssetGated — a document-level placement behaves as before; 'none' is a verdict, not neutral; the user's release overrides all", () => {
    for (const asset of STATES) for (const doc of STATES) {
      expect(isPlacedChainGated(undefined, asset, doc, false)).toBe(isPlacedAssetGated(asset, doc, false));
      expect(isPlacedChainGated('invalid', asset, doc, true)).toBe(false);
    }
    // An unsigned OUTER weakens a signed inner in a signed document — that is the chain speaking, not the document.
    expect(isPlacedChainGated('none', 'valid', 'valid', false)).toBe(true);
    expect(isPlacedChainGated(undefined, 'valid', 'valid', false)).toBe(false);
  });
});

describe('(3) unsigned document → BROKEN outer asset → unsigned inner asset: the inner is gated through its chain', () => {
  let host: ParityHost;
  let loaded: Awaited<ReturnType<typeof loadAsSinglePlacement>>;
  let innerUrl = '';
  beforeAll(async () => {
    resetProblemsForTests();
    host = await createParityHost();
    // Outer: the Machine of nested fixture (n1) with a planner reference `Cell_1`;
    // inner: parity fixture (g) — Cell: Slide {Drive} + Seq (LogicStep_SerialContainer → Up/Down),
    // whose Slide moves ONLY through its LogicStep, so a held logic is visible as "does not move".
    const outerFixture = nestedParityFixture('n1');
    const innerBytes = await fixtureBytes(parityFixture('g').build());
    innerUrl = URL.createObjectURL(new Blob([innerBytes], { type: 'model/gltf-binary' }));
    const outerBytes = withBrokenSignature(await fixtureBytes(outerFixture.buildOuter(innerUrl)));
    loaded = await loadAsSinglePlacement(host, outerBytes, outerFixture.rootName);
  }, 120_000);
  afterAll(() => { URL.revokeObjectURL(innerUrl); loaded?.release(); host?.dispose(); resetProblemsForTests(); });

  it('the outer carries its OWN broken verdict, the inner is unsigned, and the inner instance carries the chain', () => {
    expect(BROKEN).toContain(loaded.baked!.signatureState);
    expect(host.viewer.getSignatureState()).toBe('none');
    expect(host.viewer.logicRunState).toBe('active');
    const nested = loaded.assetRoot.getObjectByName('Cell_1')!;
    const nestedInstance = host.viewer.bakeRegistry.instanceOf(nested)!;
    expect(nestedInstance).not.toBeNull();
    expect(nestedInstance.baked.signatureState).toBe('none');
    expect(BROKEN).toContain(nestedInstance.chainState);
  });

  it('the nested drive is constructed but its LogicStep never enters the engine: it does not move, and the Problems panel names BOTH roots as logic-gated', () => {
    const nested = loaded.assetRoot.getObjectByName('Cell_1')!;
    const slide = nested.getObjectByName('Slide')!;
    const slidePath = host.viewer.registry!.getPathForNode(slide)!;
    expect(host.viewer.registry!.getComponentTypes(slidePath)).toContain('Drive');
    // No LogicStep root of the nested placement is in the engine …
    expect(Object.keys(snapshot(loaded).logic).filter((k) => k.startsWith('Cell_1/'))).toEqual([]);
    // … so the Slide the sequence would drive stays put.
    const x0 = slide.position.x;
    snapshotAfter(loaded, 60);
    expect(slide.position.x).toBe(x0);
    const gated = getProblems().filter((p) => p.code === 'logic-gated').map((p) => p.nodePath).sort();
    expect(gated).toEqual([loaded.rootPath, host.viewer.registry!.getPathForNode(nested)!].sort());
    const nestedProblem = getProblems().find((p) => p.code === 'logic-gated' && p.nodePath === host.viewer.registry!.getPathForNode(nested));
    expect(nestedProblem?.detail).toMatch(/invalid|unverifiable/);
  });
});
