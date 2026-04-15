// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Connection State Tests
 *
 * Validates connection state management on RVViewer, plugin callbacks,
 * event emission, and fixedUpdate guard behavior with ActiveOnly.
 */
import { describe, it, expect } from 'vitest';
import { isActiveForState, type ActiveOnly } from '../src/core/engine/rv-active-only';

// ── Minimal mock of the connection state + fixedUpdate guard system ──

interface MockPlayback {
  isPlaying: boolean;
  activeOnly: ActiveOnly;
  updateCount: number;
  update(dt: number): void;
}

interface MockLogicEngine {
  activeOnly: ActiveOnly;
  updateCount: number;
  fixedUpdate(dt: number): void;
}

interface MockReplayRecording {
  activeOnly: ActiveOnly;
  updateCount: number;
  fixedUpdate(dt: number): void;
}

interface MockPlugin {
  id: string;
  connectionChanges: { state: string }[];
  onConnectionStateChanged?(state: string, host: MockViewerHost): void;
}

class MockViewerHost {
  private _connectionState: 'Connected' | 'Disconnected' = 'Connected';
  private _plugins: MockPlugin[] = [];
  events: { type: string; state: string; previous: string }[] = [];

  playback: MockPlayback | null = null;
  logicEngine: MockLogicEngine | null = null;
  replayRecordings: MockReplayRecording[] = [];

  get connectionState() { return this._connectionState; }

  setConnectionState(state: 'Connected' | 'Disconnected'): void {
    if (state === this._connectionState) return;
    const previous = this._connectionState;
    this._connectionState = state;
    for (const p of this._plugins) {
      if (p.onConnectionStateChanged) {
        p.onConnectionStateChanged(state, this);
      }
    }
    this.events.push({ type: 'connection-state-changed', state, previous });
  }

  use(plugin: MockPlugin): void {
    this._plugins.push(plugin);
  }

  fixedUpdate(dt: number): void {
    const isConnected = this._connectionState === 'Connected';

    if (this.playback && this.playback.isPlaying && isActiveForState(this.playback.activeOnly, isConnected)) {
      this.playback.update(dt);
    }

    if (this.logicEngine && isActiveForState(this.logicEngine.activeOnly, isConnected)) {
      this.logicEngine.fixedUpdate(dt);
    }

    for (const rr of this.replayRecordings) {
      if (isActiveForState(rr.activeOnly, isConnected)) {
        rr.fixedUpdate(dt);
      }
    }
  }
}

function createMockPlayback(activeOnly: ActiveOnly = 'Always', isPlaying = true): MockPlayback {
  return {
    isPlaying,
    activeOnly,
    updateCount: 0,
    update(_dt: number) { this.updateCount++; },
  };
}

function createMockLogicEngine(activeOnly: ActiveOnly = 'Always'): MockLogicEngine {
  return {
    activeOnly,
    updateCount: 0,
    fixedUpdate(_dt: number) { this.updateCount++; },
  };
}

function createMockReplayRecording(activeOnly: ActiveOnly = 'Always'): MockReplayRecording {
  return {
    activeOnly,
    updateCount: 0,
    fixedUpdate(_dt: number) { this.updateCount++; },
  };
}

describe('Connection State', () => {
  it('defaults to Connected', () => {
    const host = new MockViewerHost();
    expect(host.connectionState).toBe('Connected');
  });

  it('setConnectionState changes the state', () => {
    const host = new MockViewerHost();
    host.setConnectionState('Disconnected');
    expect(host.connectionState).toBe('Disconnected');
    host.setConnectionState('Connected');
    expect(host.connectionState).toBe('Connected');
  });

  it('emits connection-state-changed event', () => {
    const host = new MockViewerHost();
    host.setConnectionState('Disconnected');
    expect(host.events).toHaveLength(1);
    expect(host.events[0]).toEqual({
      type: 'connection-state-changed',
      state: 'Disconnected',
      previous: 'Connected',
    });
  });

  it('does not emit when setting same state', () => {
    const host = new MockViewerHost();
    host.setConnectionState('Connected');
    expect(host.events).toHaveLength(0);
  });

  it('notifies plugins via onConnectionStateChanged callback', () => {
    const host = new MockViewerHost();
    const plugin: MockPlugin = {
      id: 'test',
      connectionChanges: [],
      onConnectionStateChanged(state) { this.connectionChanges.push({ state }); },
    };
    host.use(plugin);
    host.setConnectionState('Disconnected');
    expect(plugin.connectionChanges).toEqual([{ state: 'Disconnected' }]);
  });
});

describe('fixedUpdate guards', () => {
  it('Scenario 1: Connected playback runs when viewer is Connected', () => {
    const host = new MockViewerHost();
    host.playback = createMockPlayback('Connected', true);
    host.fixedUpdate(1 / 60);
    expect(host.playback.updateCount).toBe(1);
  });

  it('Scenario 2: Connected playback stops when viewer switches to Disconnected', () => {
    const host = new MockViewerHost();
    host.playback = createMockPlayback('Connected', true);
    host.setConnectionState('Disconnected');
    host.fixedUpdate(1 / 60);
    expect(host.playback.updateCount).toBe(0);
  });

  it('Scenario 3: Always playback runs in both states', () => {
    const host = new MockViewerHost();
    host.playback = createMockPlayback('Always', true);

    host.fixedUpdate(1 / 60);
    expect(host.playback.updateCount).toBe(1);

    host.setConnectionState('Disconnected');
    host.fixedUpdate(1 / 60);
    expect(host.playback.updateCount).toBe(2);
  });

  it('Scenario 4: Disconnected logicEngine activates only when viewer is Disconnected', () => {
    const host = new MockViewerHost();
    host.logicEngine = createMockLogicEngine('Disconnected');

    // Connected: should NOT run
    host.fixedUpdate(1 / 60);
    expect(host.logicEngine.updateCount).toBe(0);

    // Disconnected: should run
    host.setConnectionState('Disconnected');
    host.fixedUpdate(1 / 60);
    expect(host.logicEngine.updateCount).toBe(1);
  });

  it('Scenario 5: Never playback never runs', () => {
    const host = new MockViewerHost();
    host.playback = createMockPlayback('Never', true);
    host.fixedUpdate(1 / 60);
    host.setConnectionState('Disconnected');
    host.fixedUpdate(1 / 60);
    expect(host.playback.updateCount).toBe(0);
  });

  it('Scenario 6: ReplayRecording with Connected activeOnly is guarded', () => {
    const host = new MockViewerHost();
    const rr1 = createMockReplayRecording('Connected');
    const rr2 = createMockReplayRecording('Always');
    host.replayRecordings = [rr1, rr2];

    // Connected: both run
    host.fixedUpdate(1 / 60);
    expect(rr1.updateCount).toBe(1);
    expect(rr2.updateCount).toBe(1);

    // Disconnected: only Always runs
    host.setConnectionState('Disconnected');
    host.fixedUpdate(1 / 60);
    expect(rr1.updateCount).toBe(1); // still 1, did not update
    expect(rr2.updateCount).toBe(2);
  });

  it('Scenario 7: Paused playback does not run even if Active matches', () => {
    const host = new MockViewerHost();
    host.playback = createMockPlayback('Always', false); // isPlaying = false
    host.fixedUpdate(1 / 60);
    expect(host.playback.updateCount).toBe(0);
  });

  it('Scenario 8: null playback does not crash', () => {
    const host = new MockViewerHost();
    host.playback = null;
    host.logicEngine = null;
    host.replayRecordings = [];
    // Should not throw
    host.fixedUpdate(1 / 60);
  });
});
