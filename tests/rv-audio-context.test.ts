// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 fix round 1 (#3, #14) — the page context's transitions on a DELAYED
 * fake: resume() / suspend() finish later and in any order, as in a browser. A
 * fast on/off, hide/show or a refused resume must always end in the state that
 * was asked for LAST, and a refused resume is not retried in a loop.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RVSoundEngine } from '../src/core/audio/rv-audio-engine';
import {
  getSharedAudioContext, resumeAudioFromGesture, setAudioContextFactory,
} from '../src/core/rv-audio-context';
import { FakeAudioContext, fakeAudioFactory, flushMicrotasks } from './helpers/fake-audio';

const engines: RVSoundEngine[] = [];
let visibility: 'visible' | 'hidden' = 'visible';
const desc = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function setVisible(v: 'visible' | 'hidden'): void {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
}

function engine(): { e: RVSoundEngine; ctx: FakeAudioContext } {
  const e = new RVSoundEngine();
  engines.push(e);
  e.activate();
  return { e, ctx: getSharedAudioContext() as unknown as FakeAudioContext };
}

beforeEach(() => {
  FakeAudioContext.reset();
  FakeAudioContext.delayed = true;
  FakeAudioContext.initialState = 'suspended';
  setAudioContextFactory(fakeAudioFactory());
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  for (const x of engines) x.dispose();
  engines.length = 0;
  setAudioContextFactory(null);
  FakeAudioContext.reset();
  if (desc) Object.defineProperty(document, 'visibilityState', desc);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('page audio context — serialised transitions (fix round 1 #3)', () => {
  it('on → off before the resume finished ends suspended', async () => {
    const { e, ctx } = engine();
    e.setEnabled(true);
    expect(ctx.pending.map((t) => t.op)).toEqual(['resume']);
    e.setEnabled(false); // the state is still "suspended" — nothing to start yet
    await ctx.settleAll(); // the late resume finishes → compared with "off" → suspend
    expect(ctx.state).toBe('suspended');
    expect(ctx.counters.suspend).toBe(1);
  });

  it('off → on before the suspend finished ends running', async () => {
    const { e, ctx } = engine();
    e.setEnabled(true);
    await ctx.settleAll();
    expect(ctx.state).toBe('running');
    e.setEnabled(false);
    e.setEnabled(true);
    e.setEnabled(false);
    e.setEnabled(true);
    await ctx.settleAll();
    expect(ctx.state).toBe('running');
  });

  it('transitions finishing in REVERSE order still end in the last wish', async () => {
    const { e, ctx } = engine();
    e.setEnabled(true);
    // A gesture resumes as well (a second pending resume) …
    void resumeAudioFromGesture();
    expect(ctx.pending.map((t) => t.op)).toEqual(['resume', 'resume']);
    ctx.settle(1); // … the newer one finishes first: running
    await flushMicrotasks();
    e.setEnabled(false); // now running → suspend is started
    expect(ctx.pending.map((t) => t.op)).toEqual(['resume', 'suspend']);
    ctx.settle(1); // suspend done
    await flushMicrotasks();
    ctx.settle(0); // the OLD resume finishes last and would leave it running …
    await flushMicrotasks();
    await ctx.settleAll(); // … the reconcile after it suspends again
    expect(ctx.state).toBe('suspended');
  });

  it('hide → show → hide quickly ends suspended; show again resumes', async () => {
    const { e, ctx } = engine();
    e.setEnabled(true);
    await ctx.settleAll();
    setVisible('hidden');
    setVisible('visible');
    setVisible('hidden');
    await ctx.settleAll();
    expect(ctx.state).toBe('suspended');
    setVisible('visible');
    await ctx.settleAll();
    expect(ctx.state).toBe('running');
  });

  it('a refused resume is not retried in a loop; the next gesture starts it', async () => {
    const { e, ctx } = engine();
    FakeAudioContext.refuseResume = 1;
    e.setEnabled(true);
    await flushMicrotasks();
    await ctx.settleAll();
    expect(ctx.counters.resume).toBe(1);
    expect(ctx.state).toBe('suspended');
    // A further wish does not hammer resume() either.
    e.setEnabled(false);
    e.setEnabled(true);
    await flushMicrotasks();
    expect(ctx.counters.resume).toBe(1);
    // The gesture clears the refusal.
    const running = resumeAudioFromGesture();
    await ctx.settleAll();
    expect(await running).toBe(true);
    expect(ctx.state).toBe('running');
  });
});
