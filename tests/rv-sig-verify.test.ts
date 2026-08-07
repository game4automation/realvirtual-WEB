// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Scene } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import {
  RV_SIG_PLACEHOLDER,
  RV_SIG_WORKER_THRESHOLD,
  verifyRvSigBuffer,
  verifyRvSigDirect,
} from '../src/core/persistence/rv-sig-verify';

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const textEncoder = new TextEncoder();

let rootKeys: CryptoKeyPair;
let rootPublicKeyBase64: string;

beforeAll(async () => {
  rootKeys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  rootPublicKeyBase64 = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', rootKeys.publicKey)));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)));
  }
  return btoa(binary);
}

function makeJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [], extras: {} }],
    nodes: [],
    ...overrides,
  };
}

function makeGlb(json: Record<string, unknown>, binBytes = 0): ArrayBuffer {
  return makeGlbFromText(JSON.stringify(json), binBytes);
}

function makeGlbFromText(text: string, binBytes = 0): ArrayBuffer {
  const json = textEncoder.encode(text);
  const jsonLength = (json.length + 3) & ~3;
  const binLength = (binBytes + 3) & ~3;
  const total = 20 + jsonLength + (binLength > 0 ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  out.fill(0x20, 20, 20 + jsonLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  out.set(json, 20);
  if (binLength > 0) {
    const offset = 20 + jsonLength;
    view.setUint32(offset, binLength, true);
    view.setUint32(offset + 4, BIN_CHUNK, true);
  }
  return out.buffer;
}

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

async function signGlb(
  json: Record<string, unknown>,
  privateKey = rootKeys.privateKey,
  binBytes = 0,
): Promise<ArrayBuffer> {
  const scenes = json.scenes as Array<Record<string, unknown>>;
  const sceneIndex = typeof json.scene === 'number' ? json.scene : 0;
  const extras = (scenes[sceneIndex].extras ??= {}) as Record<string, unknown>;
  extras.rv_sig = RV_SIG_PLACEHOLDER;
  const buffer = makeGlb(json, binBytes);
  const bytes = new Uint8Array(buffer);
  const marker = textEncoder.encode(RV_SIG_PLACEHOLDER);
  const offset = findBytes(bytes, marker);
  expect(offset).toBeGreaterThan(0);
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, Uint8Array.from(bytes)));
  bytes.set(textEncoder.encode(bytesToBase64(signature)), offset);
  return buffer;
}

function corruptSignature(buffer: ArrayBuffer): void {
  const bytes = new Uint8Array(buffer);
  const prefix = textEncoder.encode('"rv_sig":"');
  const offset = findBytes(bytes, prefix);
  expect(offset).toBeGreaterThan(0);
  const signatureOffset = offset + prefix.length;
  bytes[signatureOffset] = bytes[signatureOffset] === 0x41 ? 0x42 : 0x41;
}

function customerCertificateMessage(publicKey: Uint8Array, organization: string): Uint8Array {
  const prefix = textEncoder.encode('RV-KEY-V1');
  const org = textEncoder.encode(organization.normalize('NFC'));
  const out = new Uint8Array(prefix.length + publicKey.length + 4 + org.length);
  out.set(prefix);
  out.set(publicKey, prefix.length);
  new DataView(out.buffer).setUint32(prefix.length + publicKey.length, org.length, true);
  out.set(org, prefix.length + publicKey.length + 4);
  return out;
}

describe('rv_sig roundtrip and field handling', () => {
  it('verifies a signed GLB and still parses with an unchanged GLTFLoader', async () => {
    const signed = await signGlb(makeJson());
    const result = await verifyRvSigDirect(signed, { rootPublicKeyBase64 });
    expect(result).toMatchObject({ state: 'valid', signaturePresent: true });
    const gltf = await new GLTFLoader().parseAsync(signed.slice(0), '');
    expect(gltf.scene).toBeTruthy();
  });

  it('returns none for a missing or removed signature without false substring matches', async () => {
    const unsigned = makeGlb(makeJson({ nodes: [{ name: `part-rv_sig-${RV_SIG_PLACEHOLDER}` }] }));
    expect(await verifyRvSigDirect(unsigned, { rootPublicKeyBase64 })).toMatchObject({
      state: 'none',
      signaturePresent: false,
    });
    const formerlySignedJson = makeJson();
    const formerlySigned = await signGlb(formerlySignedJson);
    expect((await verifyRvSigDirect(formerlySigned, { rootPublicKeyBase64 })).state).toBe('valid');
    delete ((formerlySignedJson.scenes as Array<{ extras: Record<string, unknown> }>)[0].extras.rv_sig);
    expect((await verifyRvSigDirect(makeGlb(formerlySignedJson), { rootPublicKeyBase64 })).state).toBe('none');
  });

  it('rejects duplicate, malformed, non-canonical and non-standard Base64 fields', async () => {
    const base = JSON.stringify(makeJson());
    const withField = base.replace('"extras":{}', `"extras":{"rv_sig":"${RV_SIG_PLACEHOLDER}"}`);
    const duplicate = withField.replace(
      `"rv_sig":"${RV_SIG_PLACEHOLDER}"`,
      `"rv_sig":"${RV_SIG_PLACEHOLDER}","rv_sig":"${RV_SIG_PLACEHOLDER}"`,
    );
    const whitespace = withField.replace('"rv_sig":', '"rv_sig" :');
    const escapedKey = withField.replace('"rv_sig"', '"rv\\u005fsig"');
    for (const text of [duplicate, whitespace, escapedKey]) {
      expect((await verifyRvSigDirect(makeGlbFromText(text), { rootPublicKeyBase64 })).state).toBe('invalid');
    }
    for (const value of ['short', '-'.repeat(86) + '==', 'A'.repeat(86), 'A'.repeat(88)]) {
      const json = makeJson();
      ((json.scenes as Array<{ extras: Record<string, unknown> }>)[0].extras).rv_sig = value;
      expect((await verifyRvSigDirect(makeGlb(json), { rootPublicKeyBase64 })).state).toBe('invalid');
    }
    const nonString = makeJson();
    ((nonString.scenes as Array<{ extras: Record<string, unknown> }>)[0].extras).rv_sig = 123;
    expect(await verifyRvSigDirect(makeGlb(nonString), { rootPublicKeyBase64 })).toMatchObject({
      state: 'invalid',
      signaturePresent: true,
    });

    const lyingLength = makeGlb(makeJson());
    new DataView(lyingLength).setUint32(8, lyingLength.byteLength + 4, true);
    expect((await verifyRvSigDirect(lyingLength, { rootPublicKeyBase64 })).state).toBe('invalid');
    const noJson = makeGlb(makeJson());
    new DataView(noJson).setUint32(16, BIN_CHUNK, true);
    expect((await verifyRvSigDirect(noJson, { rootPublicKeyBase64 })).state).toBe('invalid');
  });

  it('rejects a correctly signed file from an unrelated key', async () => {
    const foreign = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const signed = await signGlb(makeJson(), foreign.privateKey);
    expect((await verifyRvSigDirect(signed, { rootPublicKeyBase64 })).state).toBe('invalid');
  });
});

describe('rv_sig customer provenance and fallback', () => {
  it('accepts a root-certified customer key and rejects certificate/file mismatches', async () => {
    const customer = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const customerRaw = new Uint8Array(await crypto.subtle.exportKey('raw', customer.publicKey));
    const organization = 'Müller Automation';
    const certSig = new Uint8Array(await crypto.subtle.sign(
      'Ed25519',
      rootKeys.privateKey,
      Uint8Array.from(customerCertificateMessage(customerRaw, organization)),
    ));
    const certificate = {
      pub: bytesToBase64(customerRaw),
      org: organization,
      sig: bytesToBase64(certSig),
    };
    const json = makeJson();
    ((json.scenes as Array<{ extras: Record<string, unknown> }>)[0].extras).rv_key = certificate;
    const signed = await signGlb(json, customer.privateKey);
    expect(await verifyRvSigDirect(signed, { rootPublicKeyBase64 })).toMatchObject({
      state: 'valid',
      signerOrganization: organization,
    });

    const tamperedOrg = signed.slice(0);
    const bytes = new Uint8Array(tamperedOrg);
    const orgOffset = findBytes(bytes, textEncoder.encode(organization));
    bytes[orgOffset] ^= 1;
    expect((await verifyRvSigDirect(tamperedOrg, { rootPublicKeyBase64 })).state).toBe('invalid');

    const rootSignedWithCustomerCert = await signGlb(json, rootKeys.privateKey);
    expect((await verifyRvSigDirect(rootSignedWithCustomerCert, { rootPublicKeyBase64 })).state).toBe('invalid');
  });

  it('uses the dynamically imported fallback and reports unverifiable when both paths are unavailable', async () => {
    const signed = await signGlb(makeJson());
    expect((await verifyRvSigDirect(signed, {
      rootPublicKeyBase64,
      forceFallback: true,
    })).state).toBe('valid');
    expect((await verifyRvSigDirect(signed, {
      rootPublicKeyBase64,
      forceFallback: true,
      disableFallback: true,
    })).state).toBe('unverifiable');
  });
});

describe('rv_sig loader gate and signed sidecar exclusion', () => {
  it('keeps geometry but defers component lifecycle after signed bytes are changed', async () => {
    const signed = await signGlb(makeJson({
      buffers: [{ byteLength: 4 }],
    }), rootKeys.privateKey, 4);
    new Uint8Array(signed)[signed.byteLength - 1] ^= 1;
    const result = await loadGLB('https://example.invalid/cell.glb', new Scene(), { data: signed });
    expect(result.root).toBeTruthy();
    expect(result.signatureState).toBe('invalid');
    expect(result.logicGated).toBe(true);
    expect(result.deferredLogic).not.toBeNull();
  });

  it('prepares TransportSurface drive pose identically before gated kinematics', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const model = makeJson({
      scenes: [{ nodes: [0], extras: {} }],
      nodes: [{
        name: 'Belt',
        extras: {
          realvirtual: {
            Drive: { Direction: 'LinearX', StartPosition: 125 },
            TransportSurface: {},
          },
        },
      }],
    });
    const active = await loadGLB('https://example.invalid/active.glb', new Scene(), {
      data: makeGlb(structuredClone(model)),
    });
    const gated = await loadGLB('https://example.invalid/gated.glb', new Scene(), {
      data: await signGlb(structuredClone(model)),
    });
    expect(gated.logicGated).toBe(true);
    expect(active.drives).toHaveLength(1);
    expect(gated.drives).toHaveLength(1);
    expect(active.drives[0].isTransportSurface).toBe(true);
    expect(gated.drives[0].isTransportSurface).toBe(true);
    expect(gated.drives[0].node.position.toArray()).toEqual(active.drives[0].node.position.toArray());
    expect(gated.drives[0].currentPosition).toBe(active.drives[0].currentPosition);
  });

  it('gates direct loader calls that provide only a URL through the same byte verifier', async () => {
    const signed = await signGlb(makeJson({
      buffers: [{ byteLength: 4 }],
    }), rootKeys.privateKey, 4);
    new Uint8Array(signed)[signed.byteLength - 1] ^= 1;
    const fetchMock = vi.fn(async () => new Response(signed.slice(0), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await loadGLB('https://example.invalid/direct.glb', new Scene());
    expect(result.logicGated).toBe(true);
    expect(result.signatureState).toBe('invalid');
    expect(fetchMock).toHaveBeenCalledWith('https://example.invalid/direct.glb');
  });

  it('never requests a kin sidecar when rv_sig exists, regardless of verification result', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ drives: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const signed = await signGlb(makeJson());
    corruptSignature(signed);
    await loadGLB('https://example.invalid/cell.glb', new Scene(), { data: signed });
    expect(fetchMock).not.toHaveBeenCalled();

    await loadGLB('https://example.invalid/unsigned.glb', new Scene(), { data: makeGlb(makeJson()) });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('https://example.invalid/unsigned.kin.json');
  });
});

describe('rv_sig large-file Worker roundtrip', () => {
  function makeLargePlaceholder(): ArrayBuffer {
    const json = makeJson({ buffers: [{ byteLength: RV_SIG_WORKER_THRESHOLD + 4 }] });
    ((json.scenes as Array<{ extras: Record<string, unknown> }>)[0].extras).rv_sig = RV_SIG_PLACEHOLDER;
    return makeGlb(json, RV_SIG_WORKER_THRESHOLD + 4);
  }

  it('returns a non-detached buffer with the same result as the main-thread verifier', async () => {
    const signed = await signGlb(makeJson({
      buffers: [{ byteLength: RV_SIG_WORKER_THRESHOLD + 4 }],
    }), rootKeys.privateKey, RV_SIG_WORKER_THRESHOLD + 4);
    const direct = await verifyRvSigDirect(signed, { rootPublicKeyBase64 });
    const result = await verifyRvSigBuffer(signed, undefined, { rootPublicKeyBase64 });
    expect(result.state).toBe(direct.state);
    expect(result.workerUsed).toBe(true);
    expect(result.recoveredByRefetch).toBe(false);
    expect(result.buffer.byteLength).toBeGreaterThan(RV_SIG_WORKER_THRESHOLD);
    const gltf = await new GLTFLoader().parseAsync(result.buffer, '');
    expect(gltf.scene).toBeTruthy();
  }, 30_000);

  it('re-fetches geometry exactly once when Worker construction fails', async () => {
    class StartFailureWorker {
      constructor() { throw new Error('worker unavailable'); }
    }
    vi.stubGlobal('Worker', StartFailureWorker);
    const refetch = vi.fn(async () => makeGlb(makeJson()));
    const result = await verifyRvSigBuffer(makeLargePlaceholder(), refetch);
    expect(result).toMatchObject({
      state: 'unverifiable',
      signaturePresent: true,
      recoveredByRefetch: true,
    });
    expect(refetch).toHaveBeenCalledOnce();
  });

  it.each(['error', 'messageerror'] as const)('re-fetches geometry once on Worker %s', async (kind) => {
    class FailedWorker {
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      postMessage() {
        queueMicrotask(() => {
          if (kind === 'error') this.onerror?.();
          else this.onmessageerror?.();
        });
      }
      terminate() {}
    }
    vi.stubGlobal('Worker', FailedWorker);
    const refetch = vi.fn(async () => makeGlb(makeJson()));
    const result = await verifyRvSigBuffer(makeLargePlaceholder(), refetch);
    expect(result.state).toBe('unverifiable');
    expect(result.recoveredByRefetch).toBe(true);
    expect(refetch).toHaveBeenCalledOnce();
  });

  it('re-fetches geometry once after the five-second Worker timeout', async () => {
    vi.useFakeTimers();
    class TimedOutWorker {
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      postMessage() {}
      terminate() {}
    }
    vi.stubGlobal('Worker', TimedOutWorker);
    const refetch = vi.fn(async () => makeGlb(makeJson()));
    const pending = verifyRvSigBuffer(makeLargePlaceholder(), refetch);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result.state).toBe('unverifiable');
    expect(result.recoveredByRefetch).toBe(true);
    expect(refetch).toHaveBeenCalledOnce();
  });
});
