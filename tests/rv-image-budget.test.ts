// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-image-budget.test.ts — producer-side byte budget for MCP image payloads (plan-327 AP4).
 *
 * The contract under test is not "images are small" but "the bridge connection survives":
 * the peer answers an oversized WS frame by closing the socket, so an over-budget result has
 * to become a defined error BEFORE it is sent.
 *
 * Covered:
 * - normal frames encode exactly once, at the historical quality, with extras preserved
 * - over-budget frames walk a deterministic quality → scale ladder until they fit
 * - unreducible frames yield a small correlated error instead of a payload
 * - dimension guards (long edge, total pixels) fire before any encode
 * - the outer envelope guard replaces oversized frames and keeps the call id
 */
import { describe, it, expect } from 'vitest';
import {
  encodeRvImageWithinBudget,
  enforceEnvelopeBudget,
  exceedsUtf8Budget,
  utf8ByteLength,
  IMAGE_PAYLOAD_BUDGET_BYTES,
  WS_ENVELOPE_BUDGET_BYTES,
  ENVELOPE_RESERVE_BYTES,
  MAX_LONG_EDGE_PX,
  MAX_TOTAL_PIXELS,
  type BudgetImageSource,
  type ImageBudgetOptions,
} from '../src/plugins/mcp-bridge/rv-image-budget';

/**
 * Stand-in for a canvas whose encoded size is a deterministic function of pixels and quality.
 * Real JPEG size is content-dependent; the ladder only cares that smaller/lower-quality is
 * smaller, which is exactly what this models — and it makes the rungs assertable.
 */
function fakeSource(width: number, height: number, bytesPerPixel = 1): BudgetImageSource {
  return {
    width,
    height,
    toDataURL(_type: string, quality: number): string {
      const bytes = Math.max(1, Math.round(width * height * bytesPerPixel * quality));
      return `data:image/jpeg;base64,${'A'.repeat(bytes)}`;
    },
  };
}

/** Records every encode and resize so the ladder's steps can be asserted. */
function tracker(bytesPerPixel = 1) {
  const encodes: { width: number; height: number; quality: number }[] = [];
  const resizes: { width: number; height: number }[] = [];
  const make = (width: number, height: number): BudgetImageSource => ({
    width,
    height,
    toDataURL(_type: string, quality: number): string {
      encodes.push({ width, height, quality });
      const bytes = Math.max(1, Math.round(width * height * bytesPerPixel * quality));
      return `data:image/jpeg;base64,${'A'.repeat(bytes)}`;
    },
  });
  const options: ImageBudgetOptions = {
    resize: (_source, width, height) => {
      resizes.push({ width, height });
      return make(width, height);
    },
  };
  return { encodes, resizes, options, make };
}

function parsePayload(json: string): Record<string, any> {
  return JSON.parse(json) as Record<string, any>;
}

describe('utf8 measurement', () => {
  it('counts multi-byte characters as their encoded length', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('ä')).toBe(2);      // 1 char, 2 bytes
    expect(utf8ByteLength('€')).toBe(3);      // 1 char, 3 bytes
    expect(utf8ByteLength('😀')).toBe(4);     // 2 code units, 4 bytes
  });

  it('reports null below budget and the measured size above it', () => {
    expect(exceedsUtf8Budget('abcd', 10)).toBeNull();
    expect(exceedsUtf8Budget('abcdefghijk', 10)).toBe(11);
  });

  it('flags a multi-byte string that is over budget in bytes but not in characters', () => {
    // 5 characters, 10 bytes — a char-count-only check would wave this through.
    expect(exceedsUtf8Budget('€€€', 8)).toBe(9);
  });

  it('short-circuits without encoding when the character count alone exceeds the budget', () => {
    // UTF-8 is never shorter than the UTF-16 unit count, so this is already a verdict.
    // The returned number is that lower bound.
    const text = 'x'.repeat(100);
    expect(exceedsUtf8Budget(text, 50)).toBe(100);
  });
});

describe('encodeRvImageWithinBudget — normal frames', () => {
  it('encodes once at the historical quality and keeps every extra field', () => {
    const t = tracker(0.001);
    const payload = encodeRvImageWithinBudget(t.make(800, 600), {
      crop: { left: 0, top: 0, width: 800, height: 600 },
      legend: { 1: 'Robot/Axis1' },
    }, t.options);

    expect(t.encodes).toHaveLength(1);
    expect(t.encodes[0].quality).toBe(0.72);
    expect(t.resizes).toHaveLength(0);

    const image = parsePayload(payload).__rvImage;
    expect(image.mimeType).toBe('image/jpeg');
    expect(image.width).toBe(800);
    expect(image.height).toBe(600);
    expect(image.legend).toEqual({ 1: 'Robot/Axis1' });
    expect(image.crop).toEqual({ left: 0, top: 0, width: 800, height: 600 });
    expect(typeof image.data).toBe('string');
  });

  it('produces byte-identical output for the same input (deterministic)', () => {
    const first = encodeRvImageWithinBudget(fakeSource(400, 300, 0.01), { frames: 4 },
      { resize: (_s, w, h) => fakeSource(w, h, 0.01) });
    const second = encodeRvImageWithinBudget(fakeSource(400, 300, 0.01), { frames: 4 },
      { resize: (_s, w, h) => fakeSource(w, h, 0.01) });
    expect(first).toBe(second);
  });

  it('reserves envelope headroom below the peer message limit', () => {
    // 2 MiB is the peer's hard MaxMessageBytes; the operative budget must stay under it,
    // and the payload budget under the frame budget.
    expect(WS_ENVELOPE_BUDGET_BYTES).toBeLessThan(2 * 1024 * 1024);
    expect(IMAGE_PAYLOAD_BUDGET_BYTES).toBe(WS_ENVELOPE_BUDGET_BYTES - ENVELOPE_RESERVE_BYTES);
  });
});

describe('encodeRvImageWithinBudget — reduction ladder', () => {
  it('drops quality first and returns the first rung that fits', () => {
    const t = tracker(1);
    // 100x100 = 10 000 px. At q=0.72 → 7 200 base64 bytes; budget 6 000 forces q=0.55 (5 500).
    const payload = encodeRvImageWithinBudget(t.make(100, 100), undefined,
      { ...t.options, budgetBytes: 6_000 });

    expect(t.encodes.map(e => e.quality)).toEqual([0.72, 0.55]);
    expect(t.resizes).toHaveLength(0);
    const image = parsePayload(payload).__rvImage;
    expect(image.width).toBe(100);
    expect(utf8ByteLength(payload)).toBeLessThanOrEqual(6_000);
  });

  it('downscales after the quality ladder is exhausted, and stays within budget', () => {
    const t = tracker(1);
    // Nothing at full size fits (lowest is 10 000 * 0.4 = 4 000 > 3 000), so scale 0.7 runs.
    const payload = encodeRvImageWithinBudget(t.make(100, 100), undefined,
      { ...t.options, budgetBytes: 3_000 });

    expect(t.encodes.slice(0, 3).map(e => e.quality)).toEqual([0.72, 0.55, 0.4]);
    expect(t.resizes[0]).toEqual({ width: 70, height: 70 });
    expect(t.encodes[3]).toEqual({ width: 70, height: 70, quality: 0.72 });

    const image = parsePayload(payload).__rvImage;
    expect(image.width).toBeLessThan(100);
    expect(utf8ByteLength(payload)).toBeLessThanOrEqual(3_000);
  });

  it('returns a small correlated error when even the smallest rung misses', () => {
    const t = tracker(1);
    const payload = encodeRvImageWithinBudget(t.make(1_000, 1_000), undefined,
      { ...t.options, budgetBytes: 500 });

    const parsed = parsePayload(payload);
    expect(parsed.__rvImage).toBeUndefined();
    expect(parsed.error).toContain('budget');
    expect(parsed.imageBudgetExceeded.budgetBytes).toBe(500);
    expect(parsed.imageBudgetExceeded.bytesAtLeast).toBeGreaterThan(500);
    expect(parsed.imageBudgetExceeded.width).toBeLessThan(1_000);
    expect(parsed.imageBudgetExceeded.attempts).toBeGreaterThan(1);
    // "Small" is the point of the error: it must never itself be a large frame.
    expect(utf8ByteLength(payload)).toBeLessThan(1_000);
  });

  it('never sends an over-budget payload, whatever the ladder decided', () => {
    for (const budget of [500, 3_000, 6_000, 50_000]) {
      const payload = encodeRvImageWithinBudget(fakeSource(200, 200, 1), undefined,
        { budgetBytes: budget, resize: (_s, w, h) => fakeSource(w, h, 1) });
      expect(utf8ByteLength(payload)).toBeLessThanOrEqual(budget);
    }
  });

  it('falls back to the unscaled frame when the resize path is unavailable', () => {
    // No 2D context (headless/odd renderer): the ladder cannot reduce, so it must produce the
    // error rather than throw or emit an oversized payload.
    const payload = encodeRvImageWithinBudget(fakeSource(100, 100, 1), undefined,
      { budgetBytes: 1_000, resize: () => null });
    expect(parsePayload(payload).imageBudgetExceeded).toBeDefined();
  });
});

describe('encodeRvImageWithinBudget — dimension guards', () => {
  it('clamps the long edge before encoding', () => {
    const t = tracker(0.000001);
    encodeRvImageWithinBudget(t.make(6_000, 1_000), undefined, t.options);
    // Guard fires first: the very first encode already happens at the clamped size.
    expect(t.resizes[0].width).toBe(MAX_LONG_EDGE_PX);
    expect(t.encodes[0].width).toBe(MAX_LONG_EDGE_PX);
  });

  it('clamps total pixels even when both edges are individually acceptable', () => {
    const t = tracker(0.000001);
    encodeRvImageWithinBudget(t.make(2_400, 2_400), undefined, t.options); // 5.76 MP < guard
    expect(t.resizes).toHaveLength(0);

    const u = tracker(0.000001);
    encodeRvImageWithinBudget(u.make(2_000, 2_000), undefined,
      { ...u.options, maxTotalPixels: 1_000_000 });
    expect(u.encodes[0].width * u.encodes[0].height).toBeLessThanOrEqual(1_000_000);
  });

  it('leaves every dimension the capture paths really produce untouched', () => {
    // screenshot 1400, burst montage 1600 wide, analyze mosaic 2048x2096 — the guards exist
    // for the unbounded cases (portrait montage height), not to alter normal output.
    for (const [w, h] of [[1400, 1400], [1600, 1600], [2048, 2096]] as const) {
      const t = tracker(0.000001);
      encodeRvImageWithinBudget(t.make(w, h), undefined, t.options);
      expect(t.resizes).toHaveLength(0);
      expect(t.encodes[0]).toEqual({ width: w, height: h, quality: 0.72 });
      expect(w * h).toBeLessThanOrEqual(MAX_TOTAL_PIXELS);
    }
  });
});

describe('enforceEnvelopeBudget', () => {
  it('passes a normal frame through unchanged', () => {
    const frame = JSON.stringify({ type: 'result', id: 7, result: '{"ok":true}' });
    expect(enforceEnvelopeBudget(frame, 7)).toBe(frame);
  });

  it('replaces an oversized frame with an error carrying the same call id', () => {
    const frame = JSON.stringify({ type: 'result', id: 42, result: 'x'.repeat(5_000) });
    const guarded = enforceEnvelopeBudget(frame, 42, 1_000);
    const parsed = parsePayload(guarded);

    expect(parsed.id).toBe(42);
    expect(parsed.type).toBe('result');
    expect(parsed.result).toBeUndefined();
    expect(parsed.error).toContain('exceeds');
    expect(utf8ByteLength(guarded)).toBeLessThan(1_000);
  });

  it('guards non-image results too — a huge text reply must not close the socket', () => {
    const frame = JSON.stringify({ type: 'result', id: 3, result: JSON.stringify({ nodes: 'y'.repeat(9_000) }) });
    const parsed = parsePayload(enforceEnvelopeBudget(frame, 3, 2_000));
    expect(parsed.error).toBeDefined();
    expect(parsed.id).toBe(3);
  });

  it('defaults to the frame budget below the peer limit', () => {
    const frame = JSON.stringify({ type: 'result', id: 1, result: 'z'.repeat(100) });
    expect(enforceEnvelopeBudget(frame, 1)).toBe(frame);
    expect(WS_ENVELOPE_BUDGET_BYTES).toBeLessThan(2 * 1024 * 1024);
  });
});

describe('real canvas path', () => {
  it('encodes an actual canvas into a parseable __rvImage payload', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext('2d');
    expect(ctx).not.toBeNull();
    ctx!.fillStyle = '#3355ff';
    ctx!.fillRect(0, 0, 64, 48);

    const image = parsePayload(encodeRvImageWithinBudget(canvas, { crop: { left: 0, top: 0, width: 64, height: 48 } })).__rvImage;
    expect(image.width).toBe(64);
    expect(image.height).toBe(48);
    expect(image.mimeType).toBe('image/jpeg');
    expect(image.data.length).toBeGreaterThan(0);
    // Valid base64 — the C# side writes these bytes verbatim into the MCP image block.
    expect(() => atob(image.data)).not.toThrow();
  });

  it('reduces a real canvas until it fits a deliberately tiny budget', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d')!;
    // Noise compresses badly — a flat fill would trivially fit any budget.
    const pixels = ctx.createImageData(512, 512);
    for (let i = 0; i < pixels.data.length; i += 4) {
      pixels.data[i] = (i * 7) % 256;
      pixels.data[i + 1] = (i * 13) % 256;
      pixels.data[i + 2] = (i * 29) % 256;
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);

    const budget = 20_000;
    const payload = encodeRvImageWithinBudget(canvas, undefined, { budgetBytes: budget });
    expect(utf8ByteLength(payload)).toBeLessThanOrEqual(budget);
    const parsed = parsePayload(payload);
    // Either it fit after reduction, or it produced the defined error — never an oversized frame.
    expect(parsed.__rvImage ?? parsed.imageBudgetExceeded).toBeDefined();
  });
});
