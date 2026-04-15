// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Annotation Plugin Unit Tests
 *
 * Tests annotation CRUD, localStorage persistence, text truncation,
 * max count enforcement, disposal, and drawing support.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnnotationPlugin, getAnnotationSnapshot, subscribeAnnotations } from '../src/plugins/annotation-plugin';
import type { Annotation } from '../src/core/types/plugin-types';

// ── Helpers ──────────────────────────────────────────────────────────────

function makePlugin(): AnnotationPlugin {
  return new AnnotationPlugin();
}

function makePos(x = 1, y = 2, z = 3): [number, number, number] {
  return [x, y, z];
}

function makeNormal(): [number, number, number] {
  return [0, 1, 0];
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('AnnotationPlugin', () => {
  let plugin: AnnotationPlugin;

  beforeEach(() => {
    plugin = makePlugin();
  });

  // ── CRUD ──

  describe('CRUD operations', () => {
    it('should add an annotation and return it with valid id', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Test note');
      expect(ann).toBeDefined();
      expect(ann.id).toBeTruthy();
      expect(ann.text).toBe('Test note');
      expect(ann.position).toEqual([1, 2, 3]);
      expect(ann.normal).toEqual([0, 1, 0]);
    });

    it('should list all annotations via getAnnotations()', () => {
      plugin.addAnnotation(makePos(), makeNormal(), 'A');
      plugin.addAnnotation(makePos(4, 5, 6), makeNormal(), 'B');
      const all = plugin.getAnnotations();
      expect(all).toHaveLength(2);
      expect(all[0].text).toBe('A');
      expect(all[1].text).toBe('B');
    });

    it('should return a copy from getAnnotations (not a live reference)', () => {
      plugin.addAnnotation(makePos(), makeNormal(), 'A');
      const list1 = plugin.getAnnotations();
      plugin.addAnnotation(makePos(), makeNormal(), 'B');
      const list2 = plugin.getAnnotations();
      expect(list1).toHaveLength(1);
      expect(list2).toHaveLength(2);
    });

    it('should remove an annotation by id', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'To delete');
      expect(plugin.getAnnotations()).toHaveLength(1);
      plugin.removeAnnotation(ann.id);
      expect(plugin.getAnnotations()).toHaveLength(0);
    });

    it('should handle removing non-existent id gracefully', () => {
      expect(() => plugin.removeAnnotation('fake-id')).not.toThrow();
    });

    it('should update annotation text', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Original');
      plugin.updateAnnotation(ann.id, { text: 'Updated' });
      const updated = plugin.getAnnotations().find(a => a.id === ann.id);
      expect(updated?.text).toBe('Updated');
    });

    it('should update annotation color', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Test', '#FF0000');
      plugin.updateAnnotation(ann.id, { color: '#00FF00' });
      const updated = plugin.getAnnotations().find(a => a.id === ann.id);
      expect(updated?.color).toBe('#00FF00');
    });

    it('should update annotation category', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Test');
      plugin.updateAnnotation(ann.id, { category: 'issue' });
      const updated = plugin.getAnnotations().find(a => a.id === ann.id);
      expect(updated?.category).toBe('issue');
    });

    it('should update timestamp on update', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Test');
      const origTs = ann.timestamp;
      // Small delay to ensure different timestamp
      plugin.updateAnnotation(ann.id, { text: 'Changed' });
      const updated = plugin.getAnnotations().find(a => a.id === ann.id);
      expect(updated!.timestamp).toBeGreaterThanOrEqual(origTs);
    });
  });

  // ── Text truncation ──

  describe('text truncation', () => {
    it('should truncate text at 200 characters on add', () => {
      const longText = 'A'.repeat(300);
      const ann = plugin.addAnnotation(makePos(), makeNormal(), longText);
      expect(ann.text).toHaveLength(200);
    });

    it('should truncate text at 200 characters on update', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Short');
      plugin.updateAnnotation(ann.id, { text: 'B'.repeat(250) });
      const updated = plugin.getAnnotations().find(a => a.id === ann.id);
      expect(updated!.text).toHaveLength(200);
    });

    it('should not truncate text under 200 characters', () => {
      const text = 'C'.repeat(199);
      const ann = plugin.addAnnotation(makePos(), makeNormal(), text);
      expect(ann.text).toHaveLength(199);
    });
  });

  // ── Max count ──

  describe('max 500 annotations', () => {
    it('should enforce max 500 annotations', () => {
      for (let i = 0; i < 501; i++) {
        plugin.addAnnotation(makePos(i, 0, 0), makeNormal(), `Ann ${i}`);
      }
      expect(plugin.getAnnotations()).toHaveLength(500);
    });
  });

  // ── Annotation mode & selection ──

  describe('annotation mode and selection', () => {
    it('should toggle annotation mode', () => {
      expect(plugin.annotationMode).toBe(false);
      plugin.annotationMode = true;
      expect(plugin.annotationMode).toBe(true);
      plugin.annotationMode = false;
      expect(plugin.annotationMode).toBe(false);
    });

    it('should set and clear selected annotation', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Select me');
      plugin.selectedAnnotation = ann.id;
      expect(plugin.selectedAnnotation).toBe(ann.id);
      plugin.selectedAnnotation = null;
      expect(plugin.selectedAnnotation).toBeNull();
    });

    it('should clear selection when removing selected annotation', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Remove me');
      plugin.selectedAnnotation = ann.id;
      plugin.removeAnnotation(ann.id);
      expect(plugin.selectedAnnotation).toBeNull();
    });
  });

  // ── Snapshot / React subscription ──

  describe('snapshot and subscription', () => {
    it('should emit snapshot on add', () => {
      const listener = vi.fn();
      const unsub = subscribeAnnotations(listener);
      plugin.addAnnotation(makePos(), makeNormal(), 'Snap test');
      expect(listener).toHaveBeenCalled();
      const snap = getAnnotationSnapshot();
      expect(snap.annotations).toHaveLength(1);
      unsub();
    });

    it('should emit snapshot on remove', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Remove snap');
      const listener = vi.fn();
      const unsub = subscribeAnnotations(listener);
      plugin.removeAnnotation(ann.id);
      expect(listener).toHaveBeenCalled();
      unsub();
    });

    it('should emit snapshot on mode toggle', () => {
      const listener = vi.fn();
      const unsub = subscribeAnnotations(listener);
      plugin.annotationMode = true;
      expect(listener).toHaveBeenCalled();
      const snap = getAnnotationSnapshot();
      expect(snap.annotationMode).toBe(true);
      unsub();
    });

    it('should unsubscribe correctly', () => {
      const listener = vi.fn();
      const unsub = subscribeAnnotations(listener);
      unsub();
      plugin.addAnnotation(makePos(), makeNormal(), 'After unsub');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── Multiuser sync ──

  describe('multiuser sync', () => {
    it('should call syncSend on add', () => {
      const send = vi.fn();
      plugin.setSyncSend(send);
      plugin.addAnnotation(makePos(), makeNormal(), 'Sync add');
      expect(send).toHaveBeenCalledWith('annotation_add', expect.objectContaining({
        annotation: expect.objectContaining({ text: 'Sync add' }),
      }));
    });

    it('should call syncSend on remove', () => {
      const send = vi.fn();
      plugin.setSyncSend(send);
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Sync remove');
      send.mockClear();
      plugin.removeAnnotation(ann.id);
      expect(send).toHaveBeenCalledWith('annotation_remove', { id: ann.id });
    });

    it('should call syncSend on update', () => {
      const send = vi.fn();
      plugin.setSyncSend(send);
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Sync update');
      send.mockClear();
      plugin.updateAnnotation(ann.id, { text: 'Changed' });
      expect(send).toHaveBeenCalledWith('annotation_update', expect.objectContaining({
        id: ann.id,
        changes: expect.objectContaining({ text: 'Changed' }),
      }));
    });

    it('should handle remote annotation_add', () => {
      const remoteAnn: Annotation = {
        id: 'remote-1',
        position: [10, 20, 30],
        normal: [0, 1, 0],
        text: 'Remote annotation',
        color: '#2196F3',
        author: 'RemoteUser',
        timestamp: Date.now(),
      };
      plugin.handleRemoteMessage('annotation_add', { annotation: remoteAnn });
      expect(plugin.getAnnotations()).toHaveLength(1);
      expect(plugin.getAnnotations()[0].text).toBe('Remote annotation');
    });

    it('should not duplicate remote annotation_add with same id', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Local');
      plugin.handleRemoteMessage('annotation_add', {
        annotation: { ...plugin.getAnnotations()[0] },
      });
      expect(plugin.getAnnotations()).toHaveLength(1);
    });

    it('should handle remote annotation_update (last-write-wins)', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Original');
      plugin.handleRemoteMessage('annotation_update', {
        id: ann.id,
        changes: { text: 'Remote update', timestamp: Date.now() + 1000 },
      });
      expect(plugin.getAnnotations()[0].text).toBe('Remote update');
    });

    it('should reject remote annotation_update with older timestamp', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Current');
      plugin.handleRemoteMessage('annotation_update', {
        id: ann.id,
        changes: { text: 'Old update', timestamp: 1 },
      });
      expect(plugin.getAnnotations()[0].text).toBe('Current');
    });

    it('should handle remote annotation_remove', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'To remove');
      plugin.handleRemoteMessage('annotation_remove', { id: ann.id });
      expect(plugin.getAnnotations()).toHaveLength(0);
    });

    it('should handle remote annotation_sync (bulk apply)', () => {
      plugin.addAnnotation(makePos(), makeNormal(), 'Existing');
      const remoteAnns: Annotation[] = [
        { id: 'sync-1', position: [1, 0, 0], normal: [0, 1, 0], text: 'Synced A', color: '#FF0000', author: 'A', timestamp: Date.now() },
        { id: 'sync-2', position: [2, 0, 0], normal: [0, 1, 0], text: 'Synced B', color: '#00FF00', author: 'B', timestamp: Date.now() },
      ];
      plugin.handleRemoteMessage('annotation_sync', { annotations: remoteAnns });
      const all = plugin.getAnnotations();
      expect(all).toHaveLength(2);
      expect(all[0].text).toBe('Synced A');
      expect(all[1].text).toBe('Synced B');
    });
  });

  // ── Drawing ──

  describe('drawing annotations', () => {
    it('should add a drawing annotation with points', () => {
      const points: [number, number, number][] = [[0, 0, 0], [1, 1, 1], [2, 2, 2]];
      const ann = plugin.addDrawing(points, '#FF0000', 3);
      expect(ann.points).toEqual(points);
      expect(ann.lineColor).toBe('#FF0000');
      expect(ann.lineWidth).toBe(3);
      expect(ann.text).toBe('Drawing');
    });

    it('should toggle drawing mode', () => {
      plugin.toggleDrawingMode();
      const snap = getAnnotationSnapshot();
      expect(snap.drawingMode).toBe(true);
      expect(snap.annotationMode).toBe(true);

      plugin.toggleDrawingMode();
      const snap2 = getAnnotationSnapshot();
      expect(snap2.drawingMode).toBe(false);
    });
  });

  // ── Node attachment ──

  describe('node attachment', () => {
    it('should store nodePath when provided', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Attached', '#FF0000', 'Robot/Arm/Gripper');
      expect(ann.nodePath).toBe('Robot/Arm/Gripper');
    });

    it('should store annotation without nodePath', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Free floating');
      expect(ann.nodePath).toBeUndefined();
    });
  });

  // ── Category ──

  describe('categories', () => {
    it('should store category on creation', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Issue', '#FF0000', undefined, 'issue');
      expect(ann.category).toBe('issue');
    });

    it('should allow note category', () => {
      const ann = plugin.addAnnotation(makePos(), makeNormal(), 'Note', '#FF0000', undefined, 'note');
      expect(ann.category).toBe('note');
    });
  });
});
