// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Incremental SHA-256 (FIPS 180-4). Retains only a partial block and schedule. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private readonly H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly W = new Uint32Array(64);
  private readonly tail = new Uint8Array(64);
  private tailLength = 0;
  private length = 0;
  private result: string | undefined;

  update(bytes: Uint8Array): this {
    if (this.result !== undefined) throw new Error('SHA-256 already finalized');
    this.length += bytes.byteLength;
    let off = 0;
    if (this.tailLength) {
      const n = Math.min(64 - this.tailLength, bytes.length);
      this.tail.set(bytes.subarray(0, n), this.tailLength);
      this.tailLength += n;
      off = n;
      if (this.tailLength === 64) {
        this.compress(this.tail, 0);
        this.tailLength = 0;
      }
    }
    for (; off + 64 <= bytes.length; off += 64) this.compress(bytes, off);
    if (off < bytes.length) {
      this.tail.set(bytes.subarray(off), 0);
      this.tailLength = bytes.length - off;
    }
    return this;
  }

  digestHex(): string {
    if (this.result !== undefined) return this.result;
    const padded = new Uint8Array(this.tailLength < 56 ? 64 : 128);
    padded.set(this.tail.subarray(0, this.tailLength));
    padded[this.tailLength] = 0x80;
    const dv = new DataView(padded.buffer);
    // Do not use bitwise byte-length arithmetic: streams may exceed 4 GiB.
    dv.setUint32(padded.length - 8, Math.floor(this.length / 0x20000000), false);
    dv.setUint32(padded.length - 4, (this.length * 8) >>> 0, false);
    for (let off = 0; off < padded.length; off += 64) this.compress(padded, off);
    this.result = Array.from(this.H, h => h.toString(16).padStart(8, '0')).join('');
    return this.result;
  }

  private compress(bytes: Uint8Array, off: number): void {
    const H = this.H, W = this.W;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      W[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const w15 = W[i - 15], w2 = W[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
}

/** SHA-256 of bytes, lowercase hex, without a whole-input padding copy. */
export function sha256Hex(bytes: Uint8Array): string {
  return new Sha256().update(bytes).digestHex();
}

export function sha256HexUtf8(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}
