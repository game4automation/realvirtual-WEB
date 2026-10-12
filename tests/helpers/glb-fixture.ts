// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Minimal hand-built GLB fixtures (plan-498): a JSON chunk plus a BIN chunk,
 * no geometry. GLTFLoader parses them (nodes without meshes are plain
 * Object3Ds), so the same bytes serve the slicing unit tests and the parse-
 * entry integration tests.
 */

const GLB_MAGIC = 0x46546c67;

function align4(n: number): number {
  return (n + 3) & ~3;
}

/** Assemble a GLB from a glTF JSON object and BIN data. */
export function assembleGlb(json: Record<string, unknown>, bin: Uint8Array | null): ArrayBuffer {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(jsonBytes.byteLength);
  const binLength = bin ? align4(bin.byteLength) : 0;
  const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(jsonBytes, 20);
  if (bin) {
    const p = 20 + jsonLength;
    view.setUint32(p, binLength, true);
    view.setUint32(p + 4, 0x004e4942, true);
    out.set(bin, p + 8);
  }
  return out.buffer;
}

/**
 * A GLB whose only bufferView holds `payload`, PADDED to a multiple of 4 plus
 * `extraPadding` bytes, preceded by `leadingBytes` of filler so the view has a
 * non-zero offset.
 */
export function buildGlbWithBufferView(
  payload: Uint8Array,
  opts: { leadingBytes?: number; extraPadding?: number } = {},
): { glb: ArrayBuffer; viewIndex: number } {
  const lead = align4(opts.leadingBytes ?? 4);
  const viewLength = align4(payload.byteLength) + (opts.extraPadding ?? 4);
  const bin = new Uint8Array(lead + viewLength);
  bin.fill(0xee, 0, lead);
  bin.set(payload, lead);
  bin.fill(0xaa, lead + payload.byteLength); // padding garbage — must not leak into the slice
  const json = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: lead },
      { buffer: 0, byteOffset: lead, byteLength: viewLength },
    ],
    scenes: [{ nodes: [0] }],
    scene: 0,
    nodes: [{ name: 'Root' }],
  };
  return { glb: assembleGlb(json, bin), viewIndex: 1 };
}

/** One FMU node in {@link buildFmuGlb}. */
export interface FmuFixtureNode {
  name: string;
  /** The Fmu extras record; `FmuEmbed.bufferView` is filled in from `payload`. */
  fmu: Record<string, unknown>;
  /** Package bytes; omitted → `FmuEmbed.bufferView` stays as authored. */
  payload?: Uint8Array;
}

/**
 * A GLB `Root` → one child per FMU node, each carrying `extras.realvirtual.Fmu`.
 * Payloads with the same SHA share one bufferView (writer rule).
 */
export function buildFmuGlb(nodes: FmuFixtureNode[], rootName = 'Root'): ArrayBuffer {
  const chunks: Uint8Array[] = [];
  const views: Array<Record<string, unknown>> = [];
  const viewBySha = new Map<string, number>();
  let cursor = 0;
  const gltfNodes: Array<Record<string, unknown>> = [{ name: rootName, children: nodes.map((_, i) => i + 1) }];
  for (const n of nodes) {
    const fmu = structuredClone(n.fmu) as Record<string, unknown>;
    const embed = fmu.FmuEmbed as Record<string, unknown> | undefined;
    if (n.payload && embed) {
      const sha = String(embed.sha256);
      let index = viewBySha.get(sha);
      if (index === undefined) {
        index = views.length;
        views.push({ buffer: 0, byteOffset: cursor, byteLength: n.payload.byteLength });
        chunks.push(n.payload);
        const padded = align4(n.payload.byteLength);
        if (padded > n.payload.byteLength) chunks.push(new Uint8Array(padded - n.payload.byteLength));
        cursor += padded;
        viewBySha.set(sha, index);
      }
      embed.bufferView = index;
      embed.byteLength = n.payload.byteLength;
    }
    gltfNodes.push({ name: n.name, extras: { realvirtual: { Fmu: fmu } } });
  }
  const bin = new Uint8Array(cursor);
  let o = 0;
  for (const c of chunks) { bin.set(c, o); o += c.byteLength; }
  const json: Record<string, unknown> = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    scene: 0,
    nodes: gltfNodes,
  };
  if (views.length > 0) {
    json.buffers = [{ byteLength: bin.byteLength }];
    json.bufferViews = views;
  }
  return assembleGlb(json, views.length > 0 ? bin : null);
}

/** SHA-256 hex of some bytes (WebCrypto). */
export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
