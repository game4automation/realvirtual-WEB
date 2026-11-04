// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-626 9.5 — agent cursor store: phases, the 1.5 s afterglow, the 50-entry activity ring,
 * and target extraction from arguments AND results (web_layout_place → its placement).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTIVITY_CAP,
  CURSOR_MS,
  _resetAgentCursorForTests,
  beginAgentCall,
  endAgentCall,
  getAgentActivities,
  getAgentCursor,
  subscribeAgentCursor,
  targetsFromArgs,
  targetsFromResult,
} from '../src/core/hmi/agent-cursor-store';
import { resultFailed } from '../src/plugins/mcp-bridge/rv-mcp-agent-cursor';

beforeEach(() => {
  vi.useFakeTimers();
  _resetAgentCursorForTests(() => Date.now());
});
afterEach(() => { vi.useRealTimers(); });

describe('plan-626 agent cursor — phases', () => {
  it('running → afterglow → idle after CURSOR_MS', () => {
    const seen: string[] = [];
    subscribeAgentCursor(() => seen.push(getAgentCursor().phase));
    const seq = beginAgentCall('web_execute', 'edit', [{ kind: 'path', value: 'Cell/Slide' }]);
    expect(getAgentCursor()).toMatchObject({ phase: 'running', tool: 'web_execute' });
    endAgentCall(seq, true);
    expect(getAgentCursor().phase).toBe('afterglow');
    vi.advanceTimersByTime(CURSOR_MS - 1);
    expect(getAgentCursor().phase).toBe('afterglow');
    vi.advanceTimersByTime(1);
    expect(getAgentCursor().phase).toBe('idle');
    expect(getAgentCursor().targets).toEqual([]);
    expect(seen).toEqual(['running', 'afterglow', 'idle']);
  });

  it('an older call finishing late does not take the cursor back', () => {
    const a = beginAgentCall('web_a', 'edit', [{ kind: 'path', value: 'A' }]);
    const b = beginAgentCall('web_b', 'edit', [{ kind: 'path', value: 'B' }]);
    endAgentCall(a, true);
    expect(getAgentCursor()).toMatchObject({ phase: 'running', tool: 'web_b' });
    endAgentCall(b, false);
    expect(getAgentCursor().tool).toBe('web_b');
    expect(getAgentActivities().map((x) => [x.tool, x.ok])).toEqual([['web_a', true], ['web_b', false]]);
  });

  it('keeps the last ACTIVITY_CAP calls', () => {
    for (let i = 0; i < ACTIVITY_CAP + 7; i++) endAgentCall(beginAgentCall(`web_t${i}`, 'edit', []), true);
    const list = getAgentActivities();
    expect(list).toHaveLength(ACTIVITY_CAP);
    expect(list[0].tool).toBe('web_t7');
    expect(list[list.length - 1].tool).toBe(`web_t${ACTIVITY_CAP + 6}`);
  });

  it('records tool, class, targets and ok', () => {
    const seq = beginAgentCall('web_signal_set_bool', 'signal', []);
    endAgentCall(seq, true, [{ kind: 'path', value: 'Signals/Start' }]);
    expect(getAgentActivities()[0]).toMatchObject({
      tool: 'web_signal_set_bool', toolClass: 'signal', ok: true,
      targets: [{ kind: 'path', value: 'Signals/Start' }],
    });
  });
});

describe('plan-626 agent cursor — targets', () => {
  it('reads path arguments, paths lists and web_execute inner args', () => {
    expect(targetsFromArgs('web_editor_set_field', { path: 'Cell/Slide', paths: 'A, B' })).toEqual([
      { kind: 'path', value: 'Cell/Slide' }, { kind: 'path', value: 'A' }, { kind: 'path', value: 'B' },
    ]);
    expect(targetsFromArgs('web_execute', { id: 'editor.rename', args: { path: 'Cell/Old' } }, 'editor.rename'))
      .toEqual([{ kind: 'path', value: 'Cell/Old' }]);
    expect(targetsFromArgs('web_editor_x', { paths: '["P/1","P/2"]' }).map((t) => t.value)).toEqual(['P/1', 'P/2']);
  });

  it('web_layout_place marks the placement the RESULT names', () => {
    const before = targetsFromArgs('web_layout_place', { catalogId: 'conveyor', x: 0, y: 0, z: 0 }, 'layout.place');
    expect(before).toEqual([]);
    const after = targetsFromResult('web_layout_place', JSON.stringify({ id: 'p-17', catalogId: 'conveyor' }), 'layout.place');
    expect(after).toEqual([{ kind: 'placement', value: 'p-17' }]);
    // layout.move names its placement in the arguments already.
    expect(targetsFromArgs('web_execute', { id: 'layout.move', args: { id: 'p-17', x: 1, y: 0, z: 0 } }, 'layout.move'))
      .toEqual([{ kind: 'placement', value: 'p-17' }]);
  });

  it('reads created nodes from results, also under web_execute value', () => {
    expect(targetsFromResult('web_editor_create_empty', '{"created":"Cell/Empty_1"}'))
      .toEqual([{ kind: 'path', value: 'Cell/Empty_1' }]);
    expect(targetsFromResult('web_execute', '{"ok":true,"value":{"created":[{"path":"K/1"},"K/2"]}}'))
      .toEqual([{ kind: 'path', value: 'K/1' }, { kind: 'path', value: 'K/2' }]);
    expect(targetsFromResult('web_execute', '{"error":"refused"}')).toEqual([]);
    expect(targetsFromResult('web_x', 'not json')).toEqual([]);
  });

  it('a non-layout id is not a placement', () => {
    expect(targetsFromResult('web_knowledge_set', '{"id":"note-1"}')).toEqual([]);
  });

  it('resultFailed recognises error answers', () => {
    expect(resultFailed('{"error":"x"}')).toBe(true);
    expect(resultFailed('{"ok":false}')).toBe(true);
    expect(resultFailed('{"ok":true}')).toBe(false);
    expect(resultFailed('plain')).toBe(false);
  });
});
