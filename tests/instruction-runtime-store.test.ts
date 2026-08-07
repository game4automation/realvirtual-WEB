// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { InstructionRuntimeStore, type InstructionEntry } from '../src/core/engine/rv-instruction-runtime-store';

function entry(path: string, over: Partial<InstructionEntry> = {}): InstructionEntry {
  return {
    path,
    type: 'error',
    dismissible: true,
    isolate: false,
    dismissed: false,
    steps: [],
    since: 0,
    at: 0,
    ...over,
  };
}

describe('InstructionRuntimeStore', () => {
  it('setActive registers an entry and lists it', () => {
    const s = new InstructionRuntimeStore();
    s.setActive('p', entry('p'));
    expect(s.getActive().map((e) => e.path)).toEqual(['p']);
    expect(s.getCount()).toBe(1);
  });

  it('notifies subscribers on setActive and dismiss', () => {
    const s = new InstructionRuntimeStore();
    const cb = vi.fn();
    s.subscribe(cb);
    s.setActive('p', entry('p'));
    expect(s.getActive().length).toBe(1);
    s.dismiss('p');
    // Dismissed entries are filtered out of getActive().
    expect(s.getActive().length).toBe(0);
    expect(s.getEntry('p')?.dismissed).toBe(true);
    expect(cb).toHaveBeenCalled();
  });

  it('remove deletes an entry', () => {
    const s = new InstructionRuntimeStore();
    s.setActive('p', entry('p'));
    s.remove('p');
    expect(s.getActive()).toHaveLength(0);
    expect(s.getEntry('p')).toBeUndefined();
  });

  it('clear empties all entries (model switch)', () => {
    const s = new InstructionRuntimeStore();
    s.setActive('a', entry('a'));
    s.setActive('b', entry('b'));
    s.clear();
    expect(s.getActive()).toHaveLength(0);
  });

  it('setActive clears a prior dismissed flag (re-show)', () => {
    const s = new InstructionRuntimeStore();
    s.setActive('p', entry('p'));
    s.dismiss('p');
    expect(s.getActive()).toHaveLength(0);
    s.setActive('p', entry('p'));
    expect(s.getActive()).toHaveLength(1);
    expect(s.getEntry('p')?.dismissed).toBe(false);
  });

  it('getActive is sorted chronologically by since', () => {
    const s = new InstructionRuntimeStore();
    s.setActive('first', entry('first', { since: 10 }));
    s.setActive('second', entry('second', { since: 20 }));
    expect(s.getActive().map((e) => e.path)).toEqual(['first', 'second']);
  });

  it('dismiss on absent or already-dismissed path is a no-op (no notify)', () => {
    const s = new InstructionRuntimeStore();
    let n = 0;
    s.subscribe(() => n++);
    s.dismiss('nope');
    expect(n).toBe(0);
    s.setActive('p', entry('p'));
    const after = n;
    s.dismiss('p');
    s.dismiss('p'); // second dismiss → no notify
    expect(n).toBe(after + 1);
  });

  it('remove of absent path does not notify', () => {
    const s = new InstructionRuntimeStore();
    let n = 0;
    s.subscribe(() => n++);
    s.remove('nope');
    expect(n).toBe(0);
  });

  it('clear when already empty does not notify', () => {
    const s = new InstructionRuntimeStore();
    let n = 0;
    s.subscribe(() => n++);
    s.clear();
    expect(n).toBe(0);
  });

  it('subscribe returns a working unsubscribe', () => {
    const s = new InstructionRuntimeStore();
    let n = 0;
    const off = s.subscribe(() => n++);
    s.setActive('p', entry('p'));
    const after = n;
    off();
    s.setActive('q', entry('q'));
    expect(n).toBe(after);
  });

  it('preserves multi-step payload', () => {
    const s = new InstructionRuntimeStore();
    s.setActive('p', entry('p', {
      type: 'maintenance',
      steps: [{ instruction: 'Step 1', targetPath: 'Root/Part', targetPaths: ['Root/Part'], url: 'file://x.pdf' }],
    }));
    const e = s.getActive()[0];
    expect(e.type).toBe('maintenance');
    expect(e.steps[0].instruction).toBe('Step 1');
    expect(e.steps[0].targetPath).toBe('Root/Part');
    expect(e.steps[0].url).toBe('file://x.pdf');
  });
});
