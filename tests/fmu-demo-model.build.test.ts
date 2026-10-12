// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 Phase 4 — builds the FMU demo model with the editor's own path
 * (parser → attach gate → Fmu extras → store → asset writer) and checks the
 * result. With `RV_BUILD_FMU_DEMO=1` it also writes it to
 * `public/demo-realvirtual/fmu-demo.glb` (vite command `writeFmuDemoGlb`):
 *
 *   RV_BUILD_FMU_DEMO=1 npx vitest run tests/fmu-demo-model.build.test.ts
 *
 * Without the flag it is a drift gate: the shipped file must carry the same
 * component extras and the same embedded packages as a fresh build.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { commands } from '@vitest/browser/context';
import bouncingBallUrl from './fixtures/BouncingBall.fmu?url';
import { buildFmuDemoGlb, DEMO_E_START, SEQUENCE_DELAY_S } from './helpers/fmu-demo-scene';
import { binaryResources, collectFmuEmbeds, extractGlbBufferViews, readGlbJson } from '../src/core/engine/rv-binary-resources';
import { sha256HexOf } from './helpers/glb-fixture';

// Served from publicDir at the root path (the same URL the demo project uses).
const shippedUrl = '/demo-realvirtual/fmu-demo.glb';

async function bytesOf(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Node name → realvirtual extras, for a drift comparison independent of byte layout. */
function extrasByNode(glb: ArrayBuffer): Record<string, unknown> {
  const json = readGlbJson(glb)!;
  const out: Record<string, unknown> = {};
  for (const n of (json.nodes as Array<{ name?: string; extras?: { realvirtual?: Record<string, unknown> } }>)) {
    const rv = n.extras?.realvirtual;
    if (!rv || !n.name) continue;
    const copy = structuredClone(rv) as Record<string, Record<string, unknown>>;
    // bufferView indices depend on the geometry layout; the SHA is the identity.
    if (copy.Fmu?.FmuEmbed) delete (copy.Fmu.FmuEmbed as Record<string, unknown>).bufferView;
    out[n.name] = copy;
  }
  const scene = (json.scenes as Array<{ extras?: { realvirtual?: unknown } }>)[0];
  out['<scene>'] = scene.extras?.realvirtual ?? null;
  return out;
}

beforeEach(() => binaryResources._resetForTesting());

describe('FMU demo model (plan-498 Phase 4)', () => {
  it('builds with the BouncingBall package embedded in one bufferView; shipped file matches the recipe', async () => {
    const bb = await bytesOf(bouncingBallUrl);
    const { glb, ball } = await buildFmuDemoGlb(bb);

    const json = readGlbJson(glb)!;
    const embeds = collectFmuEmbeds(json);
    expect(embeds.map((e) => e.sha256).sort()).toEqual([ball.sha256]);
    const views = extractGlbBufferViews(glb, embeds);
    for (const v of views) expect(await sha256HexOf(v.bytes)).toBe(v.sha256);
    expect(((json.asset as any).extras.realvirtual.fmuBufferViews as number[]).length).toBe(1);

    const nodes = json.nodes as Array<{ name: string; extras?: any }>;
    const ballNode = nodes.find((n) => n.name === 'Ball')!;
    expect(Object.keys(ballNode.extras.realvirtual).sort()).toEqual(['Drive', 'Drive_FollowPosition', 'Fmu']);
    expect(ballNode.extras.realvirtual.Fmu.FmuEmbed.modelName).toBe('BouncingBall');
    // Only the ball carries an FMU; Feedthrough is a test fixture, not part of the demo.
    expect(nodes.some((n) => n.name === 'Panel')).toBe(false);
    // plan-502 F13: the restart sequence (top-level serial container → set Restart, wait).
    const seq = nodes.find((n) => n.name === 'Sequence')!;
    expect(Object.keys(seq.extras.realvirtual)).toEqual(['LogicStep_SerialContainer']);
    const setStep = nodes.find((n) => n.name === 'RestartBall')!;
    expect(setStep.extras.realvirtual.LogicStep_SetSignalBool).toMatchObject({
      Signal: { type: 'ComponentReference', path: 'Ball/Signals/Restart', componentType: 'PLCInputBool' },
      SetToTrue: true,
    });
    // User request 2026-09-26: the ball really bounces — restart every 12 s, e = 0.95 stored.
    expect(SEQUENCE_DELAY_S).toBe(12);
    expect(nodes.find((n) => n.name === 'Wait')!.extras.realvirtual.LogicStep_Delay).toEqual({ Duration: 12 });
    expect(DEMO_E_START).toBe('0.95');
    expect(ballNode.extras.realvirtual.Fmu.FmuStartOverrides).toEqual({ e: '0.95' });
    // Fmu extras carry the value ranges (plan-502 Phase 3): e 0.5…1; the override is in range
    // and on a variable that may take one (parameter + tunable).
    const eVar = (ballNode.extras.realvirtual.Fmu.FmuVariables as Array<{ name: string; min?: number; max?: number; causality?: string; variability?: string }>)
      .find((v) => v.name === 'e')!;
    expect([eVar.min, eVar.max]).toEqual([0.5, 1]);
    expect([eVar.causality, eVar.variability]).toEqual(['parameter', 'tunable']);
    // No runtime signal children in the file.
    expect(nodes.some((n) => n.name === 'Signals')).toBe(false);

    const res = await (commands as unknown as {
      writeFmuDemoGlb(b64: string): Promise<{ written: boolean; bytes?: number; reason?: string }>;
    }).writeFmuDemoGlb(toBase64(glb));
    console.log(`[fmu-demo-build] ${JSON.stringify({ bytes: glb.byteLength, ...res, ball: ball.sha256.slice(0, 12) })}`);
    if (res.written) return; // just rewritten — the drift check below compares against itself

    const shipped = await (await fetch(shippedUrl)).arrayBuffer();
    expect(extrasByNode(shipped)).toEqual(extrasByNode(glb));
    const shippedEmbeds = collectFmuEmbeds(readGlbJson(shipped)!);
    for (const v of extractGlbBufferViews(shipped, shippedEmbeds)) expect(await sha256HexOf(v.bytes)).toBe(v.sha256);
  });
});
