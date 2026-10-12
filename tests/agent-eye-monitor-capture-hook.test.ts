// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-481 §9.2 — the tap must be invisible to the agent.
 *
 * Three separable promises, and each has its own trap:
 *
 * 1. **The envelope is unchanged.** The comparison base is
 *    `encodeRvImageWithinBudget` DIRECTLY, never a second instrumented
 *    `canvasToRvImage` call — comparing the tapped function against itself
 *    proves nothing about the tap.
 * 2. **It encodes exactly once.** A tap that re-encoded to get at the bytes
 *    would double the cost of every image tool and still be byte-identical on
 *    the way out.
 * 3. **The work happens AFTER the answer is sent.** This is the finding that
 *    killed `queueMicrotask` in review: the bridge awaits `method.apply(...)`,
 *    so a microtask enqueued inside the tool runs BEFORE that continuation and
 *    therefore before `_sendResult`. The order test below is what a microtask
 *    implementation fails.
 *
 * `vi.mock`, never `vi.spyOn`, on module namespaces: the browser runner's ESM
 * namespaces are frozen (same reason as `tests/open-save-document.test.ts`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Every `encodeRvImageWithinBudget` / `encodeRvImagesWithinBudget` call. */
  encodes: [] as string[],
  /** Make the store's intake throw, to prove a tool call survives it. */
  storeThrows: false,
  /** Interleaving of "answer sent" and "monitor did its work". */
  order: [] as string[],
}));

// Count encodes at the module boundary without changing what they return.
vi.mock('../src/plugins/mcp-bridge/rv-image-budget', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/plugins/mcp-bridge/rv-image-budget')>();
  return {
    ...actual,
    encodeRvImageWithinBudget: (...args: Parameters<typeof actual.encodeRvImageWithinBudget>) => {
      h.encodes.push('single');
      return actual.encodeRvImageWithinBudget(...args);
    },
    encodeRvImagesWithinBudget: (...args: Parameters<typeof actual.encodeRvImagesWithinBudget>) => {
      h.encodes.push('multi');
      return actual.encodeRvImagesWithinBudget(...args);
    },
  };
});

// The store's intake is replaced so a SYNCHRONOUS throw can be injected and the
// macrotask boundary can be observed without depending on the real ring buffer.
vi.mock('../src/core/hmi/agent-eye-monitor-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/agent-eye-monitor-store')>();
  return {
    ...actual,
    recordAgentEyeEnvelope: (json: string, source?: string) => {
      if (h.storeThrows) throw new Error('store blew up');
      return actual.recordAgentEyeEnvelope(json, source);
    },
  };
});

import { canvasToRvImage, canvasesToRvImages } from '../src/plugins/mcp-bridge/rv-frame-capture';
import {
  encodeRvImageWithinBudget,
  encodeRvImagesWithinBudget,
} from '../src/plugins/mcp-bridge/rv-image-budget';
import {
  recordAgentEyeEnvelope,
  getAgentEyeFrames,
  resetAgentEyeMonitorForTest,
  subscribeAgentEye,
} from '../src/core/hmi/agent-eye-monitor-store';

// ─── Helpers ────────────────────────────────────────────────────────────

function canvas(w = 24, h = 18, fill = '#59a'): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  return c;
}

/**
 * A canvas JPEG cannot compress away — a flat fill encodes to a few kB at any
 * pixel size, so the budget ladder would never step down and the reduction
 * assertion below would be vacuous.
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

const flushTasks = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  h.encodes.length = 0;
  h.order.length = 0;
  h.storeThrows = false;
  resetAgentEyeMonitorForTest();
});

afterEach(() => {
  resetAgentEyeMonitorForTest();
  vi.restoreAllMocks();
});

// ─── 1. The envelope is unchanged ───────────────────────────────────────

describe('agent-eye tap · the agent sees no difference', () => {
  it('returns exactly what the untouched budget encoder returns', () => {
    const c = canvas();
    const crop = { left: 0, top: 0, width: 24, height: 18 };
    expect(canvasToRvImage(c, { crop }, 'web_screenshot'))
      .toBe(encodeRvImageWithinBudget(c, { crop }));
  });

  it('returns exactly what the untouched multi-channel encoder returns', () => {
    const channels = [
      { canvas: canvas(24, 18, '#a33'), mime: 'image/png' as const, channel: 'beauty' },
      { canvas: canvas(24, 18, '#3a3'), mime: 'image/png' as const, channel: 'idmask' },
    ];
    const extra = { channels: ['beauty', 'idmask'] };
    expect(canvasesToRvImages(channels, extra, 'web_eye'))
      .toBe(encodeRvImagesWithinBudget(channels, extra));
  });

  it('never leaks `source` into the envelope the agent receives', () => {
    const json = canvasToRvImage(canvas(), { crop: { left: 1 } }, 'web_screenshot_burst');
    expect(json).not.toContain('web_screenshot_burst');
    const parsed = JSON.parse(json) as { __rvImage: Record<string, unknown> };
    expect(parsed.__rvImage).not.toHaveProperty('source');
  });

  it('encodes exactly once', () => {
    canvasToRvImage(canvas(), undefined, 'web_screenshot');
    expect(h.encodes).toEqual(['single']);
  });

  it('encodes exactly once in the multi-channel case', () => {
    canvasesToRvImages(
      [{ canvas: canvas(), mime: 'image/png', channel: 'beauty' }],
      { channels: ['beauty'] },
      'web_eye',
    );
    expect(h.encodes).toEqual(['multi']);
  });

  it('still returns the envelope when the store throws synchronously', () => {
    h.storeThrows = true;
    const json = canvasToRvImage(canvas(), undefined, 'web_screenshot');
    expect(JSON.parse(json)).toHaveProperty('__rvImage');
  });

  it('swallows an asynchronous failure inside the macrotask', async () => {
    // A capture whose second block cannot be decoded fails INSIDE the
    // setTimeout body, where the encoder's try/catch cannot reach. Nothing may
    // escape into an unhandled rejection / global error.
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => { errors.push(e.error); };
    window.addEventListener('error', onError);
    recordAgentEyeEnvelope(JSON.stringify({
      __rvImage: { data: 'AAAA', mimeType: 'image/png', width: 2, height: 2, channels: ['a', 'b'] },
      __rvImages: [{ data: '###', mimeType: 'image/png', width: 2, height: 2, channel: 'b' }],
    }), 'web_eye');
    await flushTasks();
    window.removeEventListener('error', onError);
    expect(errors).toHaveLength(0);
    expect(getAgentEyeFrames()).toHaveLength(0);
  });
});

// ─── 2. Timing (D-A3) ───────────────────────────────────────────────────

describe('agent-eye tap · the capture is processed AFTER the answer', () => {
  it('logs "send result" before the monitor converts anything', async () => {
    // A faithful miniature of the bridge's dispatch: `_handleCall` AWAITS the
    // tool, then calls `_sendResult`, which does a synchronous `ws.send`. The
    // tool taps the store on its way out. If the store used queueMicrotask its
    // work would land in the await continuation, i.e. BEFORE the send.
    const unsubscribe = subscribeAgentEye(() => h.order.push('monitor: blob conversion'));
    try {
      const tool = async (): Promise<string> => {
        await Promise.resolve(); // a real tool has awaits in it
        return canvasToRvImage(canvas(), undefined, 'web_screenshot');
      };
      const handleCall = async () => {
        const result = await tool();
        h.order.push('bridge: send result'); // stands in for the synchronous ws.send
        return result;
      };
      await handleCall();
      await flushTasks();
      expect(h.order).toEqual(['bridge: send result', 'monitor: blob conversion']);
    } finally {
      unsubscribe();
    }
  });

  it('has produced no capture at all by the time the tool call returns', () => {
    canvasToRvImage(canvas(), undefined, 'web_screenshot');
    // Synchronously the store has only enqueued — nothing decoded, nothing
    // committed, no listener notified. That is the whole latency promise (F5).
    expect(getAgentEyeFrames()).toHaveLength(0);
  });
});

// ─── 3. Labelling and shape of a capture ────────────────────────────────

describe('agent-eye tap · what lands in the strip', () => {
  it('labels a capture with the tool that made it, not with web_eye (D-A8)', async () => {
    // Several tools share the same encoder boundary, so the tool name travels
    // as a parameter. Asserted right there, with two different source values.
    canvasesToRvImages(
      [{ canvas: canvas(), mime: 'image/png', channel: 'beauty' }],
      { channels: ['beauty'] },
      'web_view_sweep',
    );
    await flushTasks();
    expect(getAgentEyeFrames()[0].source).toBe('web_view_sweep');

    canvasesToRvImages(
      [{ canvas: canvas(), mime: 'image/png', channel: 'beauty' }],
      { channels: ['beauty'] },
      'web_eye',
    );
    await flushTasks();
    expect(getAgentEyeFrames()[0].source).toBe('web_eye');
  });

  it('accepts every one of the seven image tool names', async () => {
    const names = [
      'web_screenshot', 'web_screenshot_burst', 'web_screenshot_analyze',
      'web_view_sweep', 'web_view_ortho',
      'web_eye', 'web_editor_verify_drive',
    ];
    for (const name of names) {
      canvasToRvImage(canvas(), undefined, name);
      await flushTasks();
    }
    // Twelve-cell buffer, seven captures — all of them survive.
    expect(getAgentEyeFrames().map((f) => f.source).reverse()).toEqual(names);
  });

  it('produces exactly ONE cell for a call that also wrote a savePath (R7)', async () => {
    // `saveCanvasToProject` sits BEFORE the final encoder and is not tapped, so
    // both outcomes — written, and refused — still yield a single capture.
    canvasToRvImage(canvas(), { savedPath: 'captures/x.png' }, 'web_eye');
    await flushTasks();
    expect(getAgentEyeFrames()).toHaveLength(1);

    canvasToRvImage(canvas(), { saveError: 'No writable project is open' }, 'web_eye');
    await flushTasks();
    expect(getAgentEyeFrames()).toHaveLength(2);
  });

  it('records the REDUCED bytes when the budget ladder had to step down', async () => {
    const big = noisyCanvas(1200, 900);
    const full = encodeRvImageWithinBudget(big);
    const reduced = encodeRvImageWithinBudget(big, undefined, { budgetBytes: 30_000 });
    expect(reduced.length).toBeLessThan(full.length);
    recordAgentEyeEnvelope(reduced, 'web_screenshot');
    await flushTasks();
    const [frame] = getAgentEyeFrames();
    // The cell carries the bytes that actually went out, not the source frame.
    expect(frame.totalBytes).toBeLessThan(30_000);
    expect(frame.images[0].width).toBeLessThan(1200);
  });
});
