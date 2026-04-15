// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi } from 'vitest';
import { Object3D, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { resolveHit, type FaceRange } from '../src/core/engine/rv-raycast-geometry';

// ─── Helpers ────────────────────────────────────────────────────────

function createMockViewer() {
  const listeners = new Map<string, Set<Function>>();
  return {
    on(event: string, cb: Function) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return () => listeners.get(event)?.delete(cb);
    },
    emit(event: string, data?: unknown) {
      listeners.get(event)?.forEach(cb => cb(data));
    },
    _listeners: listeners,
  };
}

function createDriveMesh(driveName: string): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.name = driveName;
  mesh.userData = { rvType: 'Drive', rvPath: `/Root/${driveName}` };
  return mesh;
}

function createOverlayMesh(): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  mesh.userData = { _highlightOverlay: true };
  return mesh;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('resolveHit (face-range binary search)', () => {
  const faceRanges: FaceRange[] = [
    { startFace: 0, endFace: 100, objectPath: 'Root/DriveA' },
    { startFace: 100, endFace: 250, objectPath: 'Root/DriveB' },
    { startFace: 250, endFace: 300, objectPath: 'Root/Sensor1' },
    { startFace: 300, endFace: 500, objectPath: 'Root/Group/DriveC' },
  ];

  it('resolves first range', () => {
    expect(resolveHit(faceRanges, 0)).toBe('Root/DriveA');
    expect(resolveHit(faceRanges, 50)).toBe('Root/DriveA');
    expect(resolveHit(faceRanges, 99)).toBe('Root/DriveA');
  });

  it('resolves middle range', () => {
    expect(resolveHit(faceRanges, 100)).toBe('Root/DriveB');
    expect(resolveHit(faceRanges, 200)).toBe('Root/DriveB');
    expect(resolveHit(faceRanges, 249)).toBe('Root/DriveB');
  });

  it('resolves last range', () => {
    expect(resolveHit(faceRanges, 300)).toBe('Root/Group/DriveC');
    expect(resolveHit(faceRanges, 499)).toBe('Root/Group/DriveC');
  });

  it('returns null for face outside all ranges', () => {
    expect(resolveHit(faceRanges, 500)).toBeNull();
    expect(resolveHit(faceRanges, 1000)).toBeNull();
  });

  it('returns null for empty face ranges', () => {
    expect(resolveHit([], 0)).toBeNull();
  });

  it('handles boundary between ranges', () => {
    // Face 100 is the start of DriveB (exclusive end of DriveA)
    expect(resolveHit(faceRanges, 99)).toBe('Root/DriveA');
    expect(resolveHit(faceRanges, 100)).toBe('Root/DriveB');
  });

  it('handles single-face ranges', () => {
    const singleFace: FaceRange[] = [
      { startFace: 0, endFace: 1, objectPath: 'Root/Tiny' },
      { startFace: 1, endFace: 2, objectPath: 'Root/Tiny2' },
    ];
    expect(resolveHit(singleFace, 0)).toBe('Root/Tiny');
    expect(resolveHit(singleFace, 1)).toBe('Root/Tiny2');
    expect(resolveHit(singleFace, 2)).toBeNull();
  });
});

describe('RaycastManager behavior', () => {
  it('should apply exclude filters to intersections', () => {
    const overlayMesh = createOverlayMesh();
    const driveMesh = createDriveMesh('Drive1');
    const sensorVizMesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    sensorVizMesh.name = 'something_sensorViz';

    const excludeFilters = [
      (obj: Object3D) => !!obj.userData?._highlightOverlay,
      (obj: Object3D) => !!obj.userData?._driveHoverOverlay,
      (obj: Object3D) => obj.name.endsWith('_sensorViz'),
    ];

    const allHits = [overlayMesh, driveMesh, sensorVizMesh];
    const filtered = allHits.filter(
      hit => !excludeFilters.some(filter => filter(hit))
    );

    expect(filtered).toEqual([driveMesh]);
  });

  it('should detect correct nodeType from userData', () => {
    const driveMesh = createDriveMesh('Axis1');

    function findNodeType(obj: Object3D): string | null {
      let current: Object3D | null = obj;
      while (current) {
        if (current.userData?.rvType) return current.userData.rvType;
        current = current.parent;
      }
      return null;
    }

    expect(findNodeType(driveMesh)).toBe('Drive');

    // Child mesh without userData should walk up
    const childMesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    driveMesh.add(childMesh);
    expect(findNodeType(childMesh)).toBe('Drive');
  });

  it('should emit drive-hover compat event with EXACT existing signature', () => {
    const viewer = createMockViewer();
    const receivedEvents: unknown[] = [];

    viewer.on('drive-hover', (data: unknown) => receivedEvents.push(data));

    const mockDrive = { name: 'Drive1', path: '/Root/Drive1' };
    viewer.emit('drive-hover', {
      drive: mockDrive,
      clientX: 450,
      clientY: 300,
    });

    expect(receivedEvents.length).toBe(1);
    const evt = receivedEvents[0] as Record<string, unknown>;
    expect(evt).toHaveProperty('clientX', 450);
    expect(evt).toHaveProperty('clientY', 300);
    expect(evt).toHaveProperty('drive', mockDrive);
    expect(evt).not.toHaveProperty('pointer');
  });

  it('should emit drive-focus compat event with node field', () => {
    const viewer = createMockViewer();
    const receivedEvents: unknown[] = [];

    viewer.on('drive-focus', (data: unknown) => receivedEvents.push(data));

    const focusNode = createDriveMesh('Drive1');
    const mockDrive = { name: 'Drive1', path: '/Root/Drive1' };

    viewer.emit('drive-focus', { drive: mockDrive, node: focusNode });

    expect(receivedEvents.length).toBe(1);
    const evt = receivedEvents[0] as Record<string, unknown>;
    expect(evt).toHaveProperty('drive', mockDrive);
    expect(evt).toHaveProperty('node', focusNode);
  });

  it('should not emit when disabled (during orbit)', () => {
    let enabled = true;
    const emitted: unknown[] = [];

    const emit = (data: unknown) => {
      if (!enabled) return;
      emitted.push(data);
    };

    emit({ nodeType: 'Drive', pointer: { x: 100, y: 200 } });
    expect(emitted.length).toBe(1);

    enabled = false;
    emit({ nodeType: 'Drive', pointer: { x: 150, y: 250 } });
    expect(emitted.length).toBe(1);

    enabled = true;
    emit({ nodeType: 'Drive', pointer: { x: 200, y: 300 } });
    expect(emitted.length).toBe(2);
  });

  it('should provide driveHover deprecation getter', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const raycastManager = { enabled: true, hoveredNode: null as Object3D | null };
    const viewer = {
      get driveHover() {
        console.warn('viewer.driveHover is deprecated, use viewer.raycastManager');
        return {
          get enabled() { return raycastManager.enabled; },
          set enabled(v: boolean) { raycastManager.enabled = v; },
          get hoveredDrive() { return raycastManager.hoveredNode; },
          pointerClientX: 0,
          pointerClientY: 0,
        };
      }
    };

    const dh = viewer.driveHover;
    expect(warnSpy).toHaveBeenCalledWith('viewer.driveHover is deprecated, use viewer.raycastManager');
    expect(dh.enabled).toBe(true);

    warnSpy.mockRestore();
  });
});
