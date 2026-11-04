// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// The bundled-demo exception to the WebComponent trust gate (plan-210 §10):
// only bytes read unmodified from this origin's `<BASE_URL>demo-realvirtual/`.

import { describe, expect, it } from 'vitest';
import {
  bundledDemoScriptTrust, fetchedUrlOf, parsedBufferSourceUrl, readTrackedBody, SCRIPT_TRUST_DEMO_BASE_PATH,
  sidecarChangedDocument, type ModelLoadSource,
} from '../src/core/engine/rv-script-trust';
import { Group, Object3D } from 'three';
import { applyKinematicsSpec } from '../src/core/behavior-runtime';
import { BundledBackend, DEMO_BASE_PATH } from '../src/core/project/backends/bundled-backend';

const PAGE = 'https://web.realvirtual.io/demo/?project=demorealvirtual';
const env = { pageHref: PAGE, baseUrl: '/demo/' };
const src = (over: Partial<ModelLoadSource> = {}): ModelLoadSource => ({
  sourceUrl: '/demo/demo-realvirtual/PalletYard.glb', identityUrl: 'rvproject:PalletYard.glb',
  hasOverlay: false, hasPlacementEdits: false, authoring: false, untrusted: false, hasSidecar: false, ...over,
});

describe('bundledDemoScriptTrust', () => {
  it('trusts a bundled demo document read from this origin', () => {
    expect(bundledDemoScriptTrust(src(), env)).toEqual({ trusted: true, reason: 'bundled demo project' });
    expect(bundledDemoScriptTrust(src({ sourceUrl: 'https://web.realvirtual.io/demo/demo-realvirtual/PalletYard.glb' }), env).trusted).toBe(true);
  });

  it('does not trust the same GLB from another origin, project folder or handed-in bytes', () => {
    const cases: Array<[Partial<ModelLoadSource>, string]> = [
      [{ sourceUrl: 'https://evil.example/demo/demo-realvirtual/PalletYard.glb' }, 'other origin'],
      [{ sourceUrl: '/demo/projects/demo-realvirtual/PalletYard.glb' }, 'not in the bundled demo project'],
      [{ sourceUrl: '/demo/PalletYard.glb' }, 'not in the bundled demo project'],
      [{ sourceUrl: '/demo/demo-realvirtual/../PalletYard.glb' }, 'encoded or relative path'],
      [{ sourceUrl: '/demo/demo-realvirtual%2fPalletYard.glb' }, 'encoded or relative path'],
      [{ sourceUrl: '/demo/demo-realvirtual/..%2fevil.glb' }, 'encoded or relative path'],
      [{ sourceUrl: '/demo/demo-realvirtual/%2e%2e%5cevil.glb' }, 'encoded or relative path'],
      [{ sourceUrl: '/demo/demo-realvirtual/%2E%2E%2Fevil.glb' }, 'encoded or relative path'],
      [{ sourceUrl: '/demo/demo-realvirtual/%252e%252e%252fevil.glb' }, 'encoded or relative path'],
      [{ sourceUrl: '/demo/demo-realvirtual/./PalletYard.glb' }, 'encoded or relative path'],
      [{ sourceUrl: '/demo/demo-realvirtual/sub' + String.fromCharCode(92) + 'x.glb' }, 'encoded or relative path'],
      [{ sourceUrl: 'blob:https://web.realvirtual.io/1234' }, 'not an http(s) source'],
      [{ sourceUrl: null }, 'bytes not read from a deploy URL'],
      [{ hasOverlay: true }, 'modified document'],
      [{ hasPlacementEdits: true }, 'modified document'],
      [{ hasSidecar: true }, 'modified document'],
      [{ authoring: true }, 'authoring load'],
      [{ untrusted: true }, 'untrusted share load'],
    ];
    for (const [over, reason] of cases) {
      expect(bundledDemoScriptTrust(src(over), env), JSON.stringify(over)).toEqual({ trusted: false, reason });
    }
    expect(bundledDemoScriptTrust(null, env).trusted).toBe(false);
    expect(bundledDemoScriptTrust(src(), { ...env, pageHref: null }).trusted).toBe(false);
  });

  it('respects the deploy base and pins the demo folder name to the backend constant', () => {
    expect(SCRIPT_TRUST_DEMO_BASE_PATH).toBe(DEMO_BASE_PATH);
    expect(bundledDemoScriptTrust(src({ sourceUrl: '/demo-realvirtual/PalletYard.glb' }), env).trusted).toBe(false);
    expect(bundledDemoScriptTrust(src({ sourceUrl: '/demo-realvirtual/PalletYard.glb' }),
      { pageHref: 'http://localhost:5173/', baseUrl: '/' }).trusted).toBe(true);
  });

  it('provenance tokens come only from a genuine, URL-bearing response body', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    // A constructed Response has no URL: no token.
    expect(fetchedUrlOf(await readTrackedBody(new Response(bytes)))).toBeNull();
    // A subclass cannot fake the URL / redirected flag: the native getters are read.
    class Forged extends Response {
      override get url(): string { return 'http://localhost:5173/demo-realvirtual/x.glb'; }
      override get redirected(): boolean { return false; }
    }
    expect(fetchedUrlOf(await readTrackedBody(new Forged(bytes)))).toBeNull();
    // A plain object posing as a response: no token, no throw.
    const fake = { url: 'http://localhost:5173/demo-realvirtual/x.glb', redirected: false, body: null,
      headers: new Headers(), arrayBuffer: async () => bytes.buffer.slice(0) } as unknown as Response;
    expect(fetchedUrlOf(await readTrackedBody(fake))).toBeNull();
    // Bytes nobody fetched have no token either.
    expect(fetchedUrlOf(new ArrayBuffer(4))).toBeNull();
    expect(fetchedUrlOf(null)).toBeNull();
    // The demo backend reading through a mocked fetch gets no token (no real final URL).
    const demo = new BundledBackend({ baseUrl: '/', basePath: DEMO_BASE_PATH, fetchImpl: (async () => new Response(bytes)) as never });
    const rec = await demo.readDocument('PalletYard.glb');
    expect(rec).not.toBeNull();
    expect(fetchedUrlOf(rec!.bytes.buffer as ArrayBuffer)).toBeNull();
  });

  it('a signature-recovery replacement buffer carries only its own token, never the original one', () => {
    const original = 'http://localhost:5173/demo-realvirtual/PalletYard.glb';
    const replacement = new ArrayBuffer(8); // re-fetched bytes nobody tokened
    expect(parsedBufferSourceUrl(original, { buffer: replacement, recoveredByRefetch: true })).toBeNull();
    // Not recovered: the parsed bytes are the original buffer (worker round-trip) — its token holds.
    expect(parsedBufferSourceUrl(original, { buffer: replacement, recoveredByRefetch: false })).toBe(original);
    expect(parsedBufferSourceUrl(null, { buffer: replacement, recoveredByRefetch: false })).toBeNull();
  });

  it('a replacement fetched through the boundary keeps ITS token (a genuine response only)', async () => {
    // A constructed Response has no URL — the replacement stays untrusted even if the original was tokened.
    const buf = await readTrackedBody(new Response(new Uint8Array([1, 2])), { stream: false });
    expect(parsedBufferSourceUrl('http://localhost:5173/demo-realvirtual/x.glb', { buffer: buf, recoveredByRefetch: true })).toBeNull();
  });

  it('a sidecar that changed the document revokes trust; one that applied nothing does not', () => {
    const root = new Group(); root.name = 'Root';
    const node = new Object3D(); node.name = 'Monitor'; root.add(node);
    const adds = applyKinematicsSpec(root, { behaviors: [{ target: 'Monitor', type: 'WebComponent', props: { Code: 'x' } }] });
    expect(sidecarChangedDocument(adds)).toBe(true);
    expect((node.userData.realvirtual as Record<string, unknown>).WebComponent).toBeTruthy();
    const nothing = applyKinematicsSpec(root, { behaviors: [{ target: 'Missing', type: 'WebComponent', props: {} }] });
    expect(sidecarChangedDocument(nothing)).toBe(false);
    expect(sidecarChangedDocument(applyKinematicsSpec(root, {}))).toBe(false);
  });
});
