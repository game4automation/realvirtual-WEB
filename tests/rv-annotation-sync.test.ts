// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Annotation Multiuser Sync Tests
 *
 * Tests annotation protocol message serialization, late-joiner recovery,
 * concurrent edits with last-write-wins, and reconnect scenarios.
 */
import { describe, it, expect, vi } from 'vitest';
import { AnnotationPlugin } from '../src/plugins/annotation-plugin';
import type { Annotation } from '../src/core/types/plugin-types';

// ── Helpers ──────────────────────────────────────────────────────────────

function makePlugin(): AnnotationPlugin {
  return new AnnotationPlugin();
}

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    position: overrides.position ?? [1, 2, 3],
    normal: overrides.normal ?? [0, 1, 0],
    text: overrides.text ?? 'Test annotation',
    color: overrides.color ?? '#FF5722',
    author: overrides.author ?? 'TestUser',
    timestamp: overrides.timestamp ?? Date.now(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Annotation Sync Protocol', () => {

  describe('message serialization round-trip', () => {
    it('should serialize annotation_add message correctly', () => {
      const plugin = makePlugin();
      const send = vi.fn();
      plugin.setSyncSend(send);

      const ann = plugin.addAnnotation([1, 2, 3], [0, 1, 0], 'Hello');
      expect(send).toHaveBeenCalledWith('annotation_add', {
        annotation: expect.objectContaining({
          id: ann.id,
          text: 'Hello',
          position: [1, 2, 3],
        }),
      });
    });

    it('should serialize annotation_update message correctly', () => {
      const plugin = makePlugin();
      const send = vi.fn();
      plugin.setSyncSend(send);

      const ann = plugin.addAnnotation([0, 0, 0], [0, 1, 0], 'Original');
      send.mockClear();

      plugin.updateAnnotation(ann.id, { text: 'Updated', color: '#0000FF' });
      expect(send).toHaveBeenCalledWith('annotation_update', {
        id: ann.id,
        changes: expect.objectContaining({
          text: 'Updated',
          color: '#0000FF',
        }),
      });
    });

    it('should serialize annotation_remove message correctly', () => {
      const plugin = makePlugin();
      const send = vi.fn();
      plugin.setSyncSend(send);

      const ann = plugin.addAnnotation([0, 0, 0], [0, 1, 0], 'To remove');
      send.mockClear();

      plugin.removeAnnotation(ann.id);
      expect(send).toHaveBeenCalledWith('annotation_remove', { id: ann.id });
    });
  });

  describe('late joiner receives annotation_sync snapshot', () => {
    it('should bulk apply annotations from sync message', () => {
      const plugin = makePlugin();
      const annotations = [
        makeAnnotation({ id: 'a1', text: 'First' }),
        makeAnnotation({ id: 'a2', text: 'Second' }),
        makeAnnotation({ id: 'a3', text: 'Third' }),
      ];

      plugin.handleRemoteMessage('annotation_sync', { annotations });
      const all = plugin.getAnnotations();
      expect(all).toHaveLength(3);
      expect(all.map(a => a.text)).toEqual(['First', 'Second', 'Third']);
    });

    it('should replace existing annotations on sync', () => {
      const plugin = makePlugin();
      plugin.addAnnotation([0, 0, 0], [0, 1, 0], 'Local existing');
      expect(plugin.getAnnotations()).toHaveLength(1);

      const remote = [makeAnnotation({ id: 'r1', text: 'Remote' })];
      plugin.handleRemoteMessage('annotation_sync', { annotations: remote });
      expect(plugin.getAnnotations()).toHaveLength(1);
      expect(plugin.getAnnotations()[0].text).toBe('Remote');
    });
  });

  describe('annotation_remove deletes correct ID', () => {
    it('should remove only the specified annotation', () => {
      const plugin = makePlugin();
      const a1 = plugin.addAnnotation([0, 0, 0], [0, 1, 0], 'Keep me');
      const a2 = plugin.addAnnotation([1, 0, 0], [0, 1, 0], 'Delete me');

      plugin.handleRemoteMessage('annotation_remove', { id: a2.id });
      const remaining = plugin.getAnnotations();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(a1.id);
    });

    it('should handle remove of non-existent ID gracefully', () => {
      const plugin = makePlugin();
      plugin.addAnnotation([0, 0, 0], [0, 1, 0], 'Existing');
      expect(() => {
        plugin.handleRemoteMessage('annotation_remove', { id: 'non-existent' });
      }).not.toThrow();
      expect(plugin.getAnnotations()).toHaveLength(1);
    });
  });

  describe('concurrent edits — last-write-wins', () => {
    it('should accept remote update with newer timestamp', () => {
      const plugin = makePlugin();
      const ann = plugin.addAnnotation([0, 0, 0], [0, 1, 0], 'Original');

      plugin.handleRemoteMessage('annotation_update', {
        id: ann.id,
        changes: { text: 'Remote wins', timestamp: Date.now() + 10000 },
      });
      expect(plugin.getAnnotations()[0].text).toBe('Remote wins');
    });

    it('should reject remote update with older timestamp', () => {
      const plugin = makePlugin();
      const ann = plugin.addAnnotation([0, 0, 0], [0, 1, 0], 'Current');

      plugin.handleRemoteMessage('annotation_update', {
        id: ann.id,
        changes: { text: 'Old remote', timestamp: 1 },
      });
      expect(plugin.getAnnotations()[0].text).toBe('Current');
    });

    it('should handle two rapid concurrent updates', () => {
      const plugin = makePlugin();
      const ann = plugin.addAnnotation([0, 0, 0], [0, 1, 0], 'Base');
      const now = Date.now();

      // Simulate User A's update arriving first
      plugin.handleRemoteMessage('annotation_update', {
        id: ann.id,
        changes: { text: 'User A', timestamp: now + 100 },
      });
      // Simulate User B's update arriving second, but with newer timestamp
      plugin.handleRemoteMessage('annotation_update', {
        id: ann.id,
        changes: { text: 'User B wins', timestamp: now + 200 },
      });
      expect(plugin.getAnnotations()[0].text).toBe('User B wins');
    });
  });

  describe('annotations not lost on brief disconnect + reconnect', () => {
    it('should keep local annotations when sync is not received', () => {
      const plugin = makePlugin();
      plugin.addAnnotation([0, 0, 0], [0, 1, 0], 'Local A');
      plugin.addAnnotation([1, 0, 0], [0, 1, 0], 'Local B');

      // Simulate disconnect (no action on plugin)
      // Simulate reconnect — no annotation_sync received yet
      expect(plugin.getAnnotations()).toHaveLength(2);
    });

    it('should merge with remote state on reconnect sync', () => {
      const plugin = makePlugin();
      plugin.addAnnotation([0, 0, 0], [0, 1, 0], 'Local');

      // Simulate reconnect with full sync including the local + new remote
      const syncData = [
        makeAnnotation({ id: 'remote-1', text: 'From server' }),
        makeAnnotation({ id: 'remote-2', text: 'Also from server' }),
      ];
      plugin.handleRemoteMessage('annotation_sync', { annotations: syncData });
      // After sync, remote state replaces local
      expect(plugin.getAnnotations()).toHaveLength(2);
      expect(plugin.getAnnotations()[0].text).toBe('From server');
    });
  });

  describe('edge cases', () => {
    it('should handle empty annotation_sync', () => {
      const plugin = makePlugin();
      plugin.addAnnotation([0, 0, 0], [0, 1, 0], 'Existing');
      plugin.handleRemoteMessage('annotation_sync', { annotations: [] });
      expect(plugin.getAnnotations()).toHaveLength(0);
    });

    it('should handle annotation_sync with invalid data gracefully', () => {
      const plugin = makePlugin();
      expect(() => {
        plugin.handleRemoteMessage('annotation_sync', { annotations: 'not-an-array' });
      }).not.toThrow();
    });

    it('should truncate remote annotation text on add', () => {
      const plugin = makePlugin();
      const longTextAnn = makeAnnotation({ text: 'X'.repeat(300) });
      plugin.handleRemoteMessage('annotation_add', { annotation: longTextAnn });
      expect(plugin.getAnnotations()[0].text).toHaveLength(200);
    });
  });
});
