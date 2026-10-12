// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-481 §9.1 — the Agent Eye Monitor ring buffer.
 *
 * Two things make this file more than a store smoke test.
 *
 * First, the ENVELOPE FIXTURES are produced by the real budget encoders
 * (`encodeRvImageWithinBudget` / `encodeRvImagesWithinBudget`), never
 * hand-written JSON. The field contract the store parses is subtle — there is no
 * `extra` object in the JSON at all (extra is spread INTO `__rvImage`), and only
 * the FOLLOW-UP blocks carry `channel`, so the first channel's name has to come
 * from the `channels[]` sidecar. A hand-written literal would happily encode the
 * store's misreading of that shape and pass.
 *
 * Second, the LIFECYCLE assertions (D-A9/D-A10) count `URL.revokeObjectURL`
 * calls. An evicted, half-converted or cleared capture that keeps its blob alive
 * is a leak the UI cannot show and no snapshot assertion would catch.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  recordAgentEyeEnvelope,
  getAgentEyeFrames,
  getAgentEyeLatestSeq,
  getAgentEyeUnseenCount,
  markAgentEyeSeen,
  clearAgentEyeFrames,
  disposeAgentEyeMonitor,
  resetAgentEyeMonitorForTest,
  setAgentEyeByteCapForTest,
  AGENT_EYE_MAX_FRAMES,
  AGENT_EYE_PENDING_LIMIT,
} from '../src/core/hmi/agent-eye-monitor-store';
import {
  encodeRvImageWithinBudget,
  encodeRvImagesWithinBudget,
} from '../src/plugins/mcp-bridge/rv-image-budget';

// ─── Fixtures ───────────────────────────────────────────────────────────

/** A real canvas — the budget encoder calls `toDataURL` on it. */
function canvas(w = 32, h = 24, fill = '#3a7'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  return c;
}

/**
 * A canvas JPEG cannot compress away.
 *
 * A flat fill encodes to a few kB whatever its pixel size, so the budget ladder
 * would never step down and the reduction test would silently assert nothing.
 * Random pixels put the encode firmly over any realistic budget.
 */
function noisyCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = (Math.random() * 256) | 0;
    img.data[i + 1] = (Math.random() * 256) | 0;
    img.data[i + 2] = (Math.random() * 256) | 0;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** One-image envelope straight from the production encoder. */
function singleEnvelope(extra?: Record<string, unknown>, w = 32, h = 24): string {
  return encodeRvImageWithinBudget(canvas(w, h), extra);
}

/** Multi-channel envelope straight from the production encoder. */
function multiEnvelope(channels: string[], extra?: Record<string, unknown>): string {
  return encodeRvImagesWithinBudget(
    channels.map((channel, i) => ({
      canvas: canvas(32, 24, i % 2 ? '#a33' : '#33a'),
      mime: 'image/png' as const,
      channel,
    })),
    { channels, ...extra },
  );
}

/** An envelope whose payload is a known number of decoded bytes. */
function envelopeOfBytes(bytes: number): string {
  // base64 of `bytes` zero bytes → the store decodes exactly `bytes` again.
  let bin = '';
  for (let i = 0; i < bytes; i++) bin += '\0';
  return JSON.stringify({
    __rvImage: { data: btoa(bin), mimeType: 'image/jpeg', width: 10, height: 10 },
  });
}

/** Let the store's `setTimeout(0)` macrotask run. */
const flushTasks = () => new Promise<void>((r) => setTimeout(r, 0));

const sumBytes = (): number =>
  getAgentEyeFrames().reduce((s, f) => s + f.totalBytes, 0);

let revoked: string[];
let created: string[];

beforeEach(() => {
  revoked = [];
  created = [];
  const realRevoke = URL.revokeObjectURL.bind(URL);
  const realCreate = URL.createObjectURL.bind(URL);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url);
    realRevoke(url);
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
    const url = realCreate(obj);
    created.push(url);
    return url;
  });
});

afterEach(() => {
  resetAgentEyeMonitorForTest();
  vi.restoreAllMocks();
});

// ─── Envelope parsing (D-A1) ────────────────────────────────────────────

describe('agent-eye-monitor-store · envelope parsing', () => {
  it('groups the N channels of one envelope into ONE capture', async () => {
    recordAgentEyeEnvelope(multiEnvelope(['beauty', 'idmask', 'depth']), 'web_eye');
    await flushTasks();
    const frames = getAgentEyeFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0].images).toHaveLength(3);
    expect(frames[0].source).toBe('web_eye');
  });

  it('takes its fields from a REAL encoder fixture, not from the source canvas', async () => {
    // The first block carries no `channel` at all — its name has to come from
    // the `channels[]` sidecar; blocks 1..n carry their own. Getting the index
    // shift wrong is the exact bug this asserts against.
    recordAgentEyeEnvelope(multiEnvelope(['beauty', 'idmask', 'edges']), 'web_eye');
    await flushTasks();
    const [frame] = getAgentEyeFrames();
    expect(frame.images.map((i) => i.channel)).toEqual(['beauty', 'idmask', 'edges']);
    expect(frame.images[0].mime).toBe('image/png');
    for (const image of frame.images) {
      expect(image.width).toBe(32);
      expect(image.height).toBe(24);
      expect(image.url.startsWith('blob:')).toBe(true);
      expect(image.bytes).toBeGreaterThan(0);
    }
  });

  it('reads dimensions and MIME from the envelope, not from the source canvas', async () => {
    // A forced budget reduction: the encoder scales the frame down, so the
    // envelope no longer matches the canvas that went in.
    const big = noisyCanvas(1200, 900);
    const reduced = encodeRvImageWithinBudget(big, undefined, { budgetBytes: 30_000 });
    const parsed = JSON.parse(reduced) as { __rvImage?: { width: number; height: number } };
    // Only meaningful if the ladder actually reduced rather than errored out.
    expect(parsed.__rvImage).toBeTruthy();
    recordAgentEyeEnvelope(reduced, 'web_screenshot');
    await flushTasks();
    const [frame] = getAgentEyeFrames();
    expect(frame.images[0].width).toBe(parsed.__rvImage!.width);
    expect(frame.images[0].height).toBe(parsed.__rvImage!.height);
    expect(frame.images[0].width).toBeLessThan(1200);
    expect(frame.images[0].mime).toBe('image/jpeg');
  });

  it('falls back to "image" when the envelope names no channel', async () => {
    recordAgentEyeEnvelope(singleEnvelope({ crop: { left: 0, top: 0, width: 1, height: 1 } }), 'web_screenshot');
    await flushTasks();
    expect(getAgentEyeFrames()[0].images[0].channel).toBe('image');
  });

  it('drops an error envelope without a cell and without an auto-open impulse (F11)', async () => {
    const before = getAgentEyeLatestSeq();
    recordAgentEyeEnvelope(JSON.stringify({ error: 'Renderer not ready' }), 'web_eye');
    recordAgentEyeEnvelope(
      JSON.stringify({ error: 'too big', imageBudgetExceeded: { bytes: 9 } }),
      'web_screenshot',
    );
    await flushTasks();
    expect(getAgentEyeFrames()).toHaveLength(0);
    expect(getAgentEyeLatestSeq()).toBe(before);
  });

  it('still produces a cell when the envelope carries saveError', async () => {
    // A failed PROJECT write says nothing about the image, which is perfectly
    // valid and must still be shown.
    recordAgentEyeEnvelope(singleEnvelope({ saveError: 'No writable project is open' }), 'web_eye');
    await flushTasks();
    expect(getAgentEyeFrames()).toHaveLength(1);
  });

  it('ignores malformed JSON without throwing', async () => {
    recordAgentEyeEnvelope('{not json', 'web_eye');
    recordAgentEyeEnvelope('{}', 'web_eye');
    await flushTasks();
    expect(getAgentEyeFrames()).toHaveLength(0);
  });

  it('labels a capture whose call site passed no tool name', async () => {
    recordAgentEyeEnvelope(singleEnvelope(), undefined);
    await flushTasks();
    expect(getAgentEyeFrames()[0].source).toBe('unknown');
  });
});

// ─── Caps (D-A4, F7) ────────────────────────────────────────────────────

describe('agent-eye-monitor-store · caps', () => {
  it('keeps at most 12 captures and revokes the evicted URLs', async () => {
    const urls: string[] = [];
    for (let i = 0; i < 15; i++) {
      recordAgentEyeEnvelope(singleEnvelope(), 'web_eye');
      await flushTasks();
      urls.push(getAgentEyeFrames()[0].images[0].url);
    }
    expect(getAgentEyeFrames()).toHaveLength(AGENT_EYE_MAX_FRAMES);
    // The three oldest are gone AND their blobs were released.
    expect(revoked).toEqual(expect.arrayContaining(urls.slice(0, 3)));
    expect(revoked).toHaveLength(3);
  });

  it('evicts earlier when the blob byte cap gives first', async () => {
    setAgentEyeByteCapForTest(300_000);
    for (let i = 0; i < 3; i++) {
      recordAgentEyeEnvelope(envelopeOfBytes(200_000), 'web_eye');
      await flushTasks();
    }
    expect(getAgentEyeFrames()).toHaveLength(1);
    expect(sumBytes()).toBeLessThanOrEqual(300_000);
  });

  it('bounds the pending queue and drops the OLDEST unprocessed capture (D-A3)', async () => {
    // Ten envelopes enqueued in one synchronous run — no macrotask in between.
    for (let i = 0; i < 10; i++) recordAgentEyeEnvelope(singleEnvelope(), `tool_${i}`);
    await flushTasks();
    const frames = getAgentEyeFrames();
    expect(frames).toHaveLength(AGENT_EYE_PENDING_LIMIT);
    // tool_0 and tool_1 fell out; tool_9 is newest and therefore first.
    expect(frames[0].source).toBe('tool_9');
    expect(frames.map((f) => f.source)).not.toContain('tool_0');
  });
});

// ─── Sequence, snapshot, unseen ─────────────────────────────────────────

describe('agent-eye-monitor-store · sequence and snapshot', () => {
  it('keeps counting seq once the buffer is full (D-A7)', async () => {
    for (let i = 0; i < 14; i++) {
      recordAgentEyeEnvelope(singleEnvelope(), 'web_eye');
      await flushTasks();
    }
    expect(getAgentEyeFrames()).toHaveLength(AGENT_EYE_MAX_FRAMES);
    expect(getAgentEyeLatestSeq()).toBe(14);
    expect(getAgentEyeFrames()[0].seq).toBe(14);
    expect(getAgentEyeFrames()[0].id).toBe('14');
  });

  it('returns the SAME snapshot reference between two mutations (D-A6)', () => {
    expect(getAgentEyeFrames()).toBe(getAgentEyeFrames());
  });

  it('mints a new snapshot reference on a real mutation', async () => {
    const before = getAgentEyeFrames();
    recordAgentEyeEnvelope(singleEnvelope(), 'web_eye');
    await flushTasks();
    expect(getAgentEyeFrames()).not.toBe(before);
  });

  it('counts unseen captures and clears the count on acknowledge', async () => {
    recordAgentEyeEnvelope(singleEnvelope(), 'web_eye');
    recordAgentEyeEnvelope(singleEnvelope(), 'web_eye');
    await flushTasks();
    expect(getAgentEyeUnseenCount()).toBe(2);
    markAgentEyeSeen();
    expect(getAgentEyeUnseenCount()).toBe(0);
  });
});

// ─── Lifecycle (D-A9, D-A10) ────────────────────────────────────────────

describe('agent-eye-monitor-store · lifecycle', () => {
  it('clear() before the flush stops the capture from appearing at all', async () => {
    recordAgentEyeEnvelope(singleEnvelope(), 'web_eye');
    clearAgentEyeFrames();
    await flushTasks();
    expect(getAgentEyeFrames()).toHaveLength(0);
    expect(getAgentEyeLatestSeq()).toBe(0);
  });

  it('clear() revokes every live URL', async () => {
    recordAgentEyeEnvelope(multiEnvelope(['beauty', 'idmask']), 'web_eye');
    await flushTasks();
    const urls = getAgentEyeFrames()[0].images.map((i) => i.url);
    clearAgentEyeFrames();
    expect(revoked).toEqual(expect.arrayContaining(urls));
    expect(getAgentEyeFrames()).toHaveLength(0);
  });

  it('revokes every URL it already made when one channel of a capture fails', async () => {
    // A valid first block, an undecodable second one: the capture must be
    // discarded WHOLE and give back the blob it already claimed.
    const good = JSON.parse(singleEnvelope()) as { __rvImage: Record<string, unknown> };
    const broken = JSON.stringify({
      __rvImage: { ...good.__rvImage, channels: ['beauty', 'idmask'] },
      __rvImages: [{ data: '!!!not base64!!!', mimeType: 'image/png', width: 4, height: 4, channel: 'idmask' }],
    });
    recordAgentEyeEnvelope(broken, 'web_eye');
    await flushTasks();
    expect(getAgentEyeFrames()).toHaveLength(0);
    expect(revoked).toHaveLength(1); // exactly the one blob that got created
  });

  it('carries on with the next capture after a failed one', async () => {
    recordAgentEyeEnvelope('{not json', 'web_eye');
    recordAgentEyeEnvelope(singleEnvelope(), 'web_eye');
    await flushTasks();
    expect(getAgentEyeFrames()).toHaveLength(1);
    expect(getAgentEyeFrames()[0].source).toBe('web_eye');
  });

  it('dispose() revokes every open URL', async () => {
    recordAgentEyeEnvelope(multiEnvelope(['beauty', 'idmask', 'depth']), 'web_eye');
    await flushTasks();
    const urls = getAgentEyeFrames()[0].images.map((i) => i.url);
    disposeAgentEyeMonitor();
    expect(revoked).toEqual(expect.arrayContaining(urls));
    expect(getAgentEyeFrames()).toHaveLength(0);
  });

  it('drops a pending capture after a real viewer teardown — no URL, no commit (D-A10)', async () => {
    // The integration point, exercised through RVViewer.dispose() itself rather
    // than through the store function it happens to call. This is the assertion
    // that would have caught "the store is only cleared from the panel".
    const { createTestViewer } = await import('./helpers/create-test-viewer');
    const handle = await createTestViewer('webgl');
    try {
      recordAgentEyeEnvelope(multiEnvelope(['beauty', 'idmask']), 'web_eye');
      const createdBefore = created.length;
      handle.viewer.dispose();
      await flushTasks();
      expect(created.length).toBe(createdBefore); // not one object URL was made
      expect(getAgentEyeFrames()).toHaveLength(0); // and nothing was committed
    } finally {
      handle.container.remove();
    }
  }, 30_000);
});
