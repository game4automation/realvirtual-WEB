// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * annotation-plugin.ts — Annotation system for the realvirtual WebViewer.
 *
 * Allows users to place persistent 3D markers with labels on any surface.
 * Annotations persist in localStorage for single-user sessions and sync
 * across multiuser sessions via the relay server.
 *
 * The plugin manages its own Raycaster for world-hit placement (not using
 * RaycastManager which only returns RV-annotated nodes). Selection of
 * annotation pins uses a separate raycast against layer 6 (ANNOTATION).
 *
 * Phase 1: Single-user annotation CRUD + rendering + localStorage
 * Phase 2: Multiuser sync (annotation_add/update/remove messages)
 * Phase 4: Drawing annotations (polyline mode)
 */

import { Raycaster, Vector2, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { UISlotEntry } from '../core/rv-ui-plugin';
import type { Annotation, AnnotationPluginAPI } from '../core/types/plugin-types';
import { AnnotationRenderer, ANNOTATION_LAYER } from './rv-annotation-renderer';

// ── Constants ──────────────────────────────────────────────────────────

const MAX_ANNOTATIONS = 500;
const MAX_TEXT_LENGTH = 200;
const LS_PREFIX = 'rv-annotations-';
const DEFAULT_COLOR = '#FF5722';

// ── External subscribers for React re-render ───────────────────────────

type Listener = () => void;

export interface AnnotationSnapshot {
  annotations: Annotation[];
  annotationMode: boolean;
  selectedAnnotation: string | null;
  drawingMode: boolean;
  /** If set, the annotation edit modal should be shown for this annotation. */
  editingAnnotationId: string | null;
}

const _listeners = new Set<Listener>();
function notifyListeners(): void {
  for (const l of _listeners) l();
}

/** React hook support: subscribe to annotation state changes. */
export function subscribeAnnotations(listener: Listener): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

let _snapshot: AnnotationSnapshot = {
  annotations: [],
  annotationMode: false,
  selectedAnnotation: null,
  drawingMode: false,
  editingAnnotationId: null,
};

export function getAnnotationSnapshot(): AnnotationSnapshot {
  return _snapshot;
}

// ── Plugin ─────────────────────────────────────────────────────────────

export class AnnotationPlugin implements RVViewerPlugin, AnnotationPluginAPI {
  readonly id = 'annotations';
  readonly order = 50;
  readonly slots: UISlotEntry[] = [];

  // ── State ──
  private _annotations: Annotation[] = [];
  private _annotationMode = false;
  private _selectedAnnotation: string | null = null;
  private _drawingMode = false;
  private _drawingPoints: [number, number, number][] = [];

  // ── Three.js ──
  private _renderer: AnnotationRenderer | null = null;
  private _worldRaycaster = new Raycaster();
  private _annotationRaycaster = new Raycaster();
  private _pointer = new Vector2();
  private _viewer: RVViewer | null = null;
  private _modelHash = '';

  // ── Multiuser sync callback ──
  private _syncSend: ((type: string, payload: object) => void) | null = null;

  // ── Bound event handlers (for cleanup) ──
  private _onPointerDown: ((e: PointerEvent) => void) | null = null;
  private _onPointerMove: ((e: PointerEvent) => void) | null = null;

  // ── Public getters ──

  get annotationMode(): boolean { return this._annotationMode; }
  set annotationMode(v: boolean) {
    this._annotationMode = v;
    if (!v) this._drawingMode = false;
    this._emitSnapshot();
  }

  get selectedAnnotation(): string | null { return this._selectedAnnotation; }
  set selectedAnnotation(v: string | null) {
    this._selectedAnnotation = v;
    this._renderer?.selectAnnotation(v);
    this._emitSnapshot();
  }

  // ── AnnotationPluginAPI ──────────────────────────────────────────────

  addAnnotation(
    position: [number, number, number],
    normal: [number, number, number],
    text: string,
    color = DEFAULT_COLOR,
    nodePath?: string,
    category?: Annotation['category'],
  ): Annotation {
    if (this._annotations.length >= MAX_ANNOTATIONS) {
      console.warn(`[AnnotationPlugin] Max annotations (${MAX_ANNOTATIONS}) reached`);
      return this._annotations[this._annotations.length - 1];
    }

    // Save current camera view with the annotation
    const cameraPos = this._viewer
      ? [this._viewer.camera.position.x, this._viewer.camera.position.y, this._viewer.camera.position.z] as [number, number, number]
      : undefined;
    const cameraTarget = this._viewer
      ? [this._viewer.controls.target.x, this._viewer.controls.target.y, this._viewer.controls.target.z] as [number, number, number]
      : undefined;

    const ann: Annotation = {
      id: crypto.randomUUID?.() ?? fallbackUUID(),
      position,
      normal,
      text: text.substring(0, MAX_TEXT_LENGTH),
      color,
      author: this._getAuthorName(),
      timestamp: Date.now(),
      nodePath,
      category,
      cameraPos,
      cameraTarget,
    };

    this._annotations.push(ann);
    this._renderer?.addAnnotation(ann);
    this._save();
    this._emitSnapshot();

    // Multiuser sync
    this._syncSend?.('annotation_add', { annotation: ann });

    return ann;
  }

  removeAnnotation(id: string): void {
    const idx = this._annotations.findIndex(a => a.id === id);
    if (idx < 0) return;
    this._annotations.splice(idx, 1);
    this._renderer?.removeAnnotation(id);
    if (this._selectedAnnotation === id) this._selectedAnnotation = null;
    this._save();
    this._emitSnapshot();

    // Multiuser sync
    this._syncSend?.('annotation_remove', { id });
  }

  updateAnnotation(id: string, changes: Partial<Pick<Annotation, 'text' | 'color' | 'category'>>): void {
    const ann = this._annotations.find(a => a.id === id);
    if (!ann) return;

    if (changes.text !== undefined) ann.text = changes.text.substring(0, MAX_TEXT_LENGTH);
    if (changes.color !== undefined) ann.color = changes.color;
    if (changes.category !== undefined) ann.category = changes.category;
    ann.timestamp = Date.now();

    this._renderer?.updateAnnotation(ann);
    this._save();
    this._emitSnapshot();

    // Multiuser sync
    this._syncSend?.('annotation_update', { id, changes: { ...changes, timestamp: ann.timestamp } });
  }

  getAnnotations(): Annotation[] {
    return [...this._annotations];
  }

  focusAnnotation(id: string): void {
    const ann = this._annotations.find(a => a.id === id);
    if (!ann || !this._viewer) return;

    this.selectedAnnotation = id;

    // Restore saved camera view if available
    if (ann.cameraPos && ann.cameraTarget) {
      this._viewer.camera.position.set(ann.cameraPos[0], ann.cameraPos[1], ann.cameraPos[2]);
      this._viewer.controls.target.set(ann.cameraTarget[0], ann.cameraTarget[1], ann.cameraTarget[2]);
    } else {
      // Fallback: compute a reasonable view from position + normal
      const target = new Vector3(ann.position[0], ann.position[1], ann.position[2]);
      const offset = new Vector3(ann.normal[0], ann.normal[1], ann.normal[2]).multiplyScalar(2);
      const camPos = target.clone().add(offset).add(new Vector3(0, 1, 0));
      this._viewer.controls.target.copy(target);
      this._viewer.camera.position.copy(camPos);
    }

    this._viewer.controls.update();
    this._viewer.markRenderDirty();
  }

  addDrawing(points: [number, number, number][], lineColor = '#FF5722', lineWidth = 2): Annotation {
    if (this._annotations.length >= MAX_ANNOTATIONS) {
      console.warn(`[AnnotationPlugin] Max annotations (${MAX_ANNOTATIONS}) reached`);
      return this._annotations[this._annotations.length - 1];
    }

    // Use midpoint as position
    const midIdx = Math.floor(points.length / 2);
    const midPt = points[midIdx] ?? points[0] ?? [0, 0, 0];

    const ann: Annotation = {
      id: crypto.randomUUID?.() ?? fallbackUUID(),
      position: midPt,
      normal: [0, 1, 0],
      text: 'Drawing',
      color: lineColor,
      author: this._getAuthorName(),
      timestamp: Date.now(),
      points,
      lineColor,
      lineWidth,
    };

    this._annotations.push(ann);
    this._renderer?.addDrawing(ann);
    this._save();
    this._emitSnapshot();

    // Multiuser sync
    this._syncSend?.('annotation_add', { annotation: ann });

    return ann;
  }

  // ── Multiuser sync integration ──────────────────────────────────────

  /** Called by MultiuserPlugin to set up sync. */
  setSyncSend(fn: (type: string, payload: object) => void): void {
    this._syncSend = fn;
  }

  /** Handle incoming annotation message from multiuser. */
  handleRemoteMessage(type: string, msg: Record<string, unknown>): void {
    switch (type) {
      case 'annotation_add': {
        const ann = msg['annotation'] as Annotation;
        if (!ann || this._annotations.some(a => a.id === ann.id)) return;
        ann.text = ann.text.substring(0, MAX_TEXT_LENGTH);
        this._annotations.push(ann);
        if (ann.points) {
          this._renderer?.addDrawing(ann);
        } else {
          this._renderer?.addAnnotation(ann);
        }
        this._emitSnapshot();
        break;
      }
      case 'annotation_update': {
        const id = msg['id'] as string;
        const changes = msg['changes'] as Record<string, unknown>;
        if (!id || !changes) return;
        const ann = this._annotations.find(a => a.id === id);
        if (!ann) return;
        // Last-write-wins: only apply if timestamp is newer
        const remoteTs = changes['timestamp'] as number ?? 0;
        if (remoteTs > 0 && remoteTs < ann.timestamp) return;
        if (typeof changes['text'] === 'string') ann.text = (changes['text'] as string).substring(0, MAX_TEXT_LENGTH);
        if (typeof changes['color'] === 'string') ann.color = changes['color'] as string;
        if (typeof changes['category'] === 'string') ann.category = changes['category'] as Annotation['category'];
        ann.timestamp = remoteTs || Date.now();
        this._renderer?.updateAnnotation(ann);
        this._emitSnapshot();
        break;
      }
      case 'annotation_remove': {
        const id = msg['id'] as string;
        if (!id) return;
        const idx = this._annotations.findIndex(a => a.id === id);
        if (idx < 0) return;
        this._annotations.splice(idx, 1);
        this._renderer?.removeAnnotation(id);
        if (this._selectedAnnotation === id) this._selectedAnnotation = null;
        this._emitSnapshot();
        break;
      }
      case 'annotation_sync': {
        const annotations = msg['annotations'] as Annotation[];
        if (!Array.isArray(annotations)) return;
        this._bulkApply(annotations);
        break;
      }
    }
  }

  // ── RVViewerPlugin lifecycle ────────────────────────────────────────

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;
    this._modelHash = this._computeModelHash(result);

    // Create renderer
    this._renderer = new AnnotationRenderer();
    this._renderer.attach(viewer.scene);
    this._renderer.setCamera(viewer.camera);

    // Enable annotation layer on camera so annotations are visible
    viewer.camera.layers.enable(ANNOTATION_LAYER);

    // Load from localStorage
    this._load();

    // Register context menu items
    viewer.contextMenu.register({
      pluginId: 'annotations',
      items: [
        {
          id: 'annotations.add',
          label: 'Annotate',
          order: 50,
          action: (target) => {
            // Use exact raycast hit point if available, otherwise node center
            const pos: [number, number, number] = target.hitPoint
              ?? (() => { const p = target.node.getWorldPosition(new Vector3()); return [p.x, p.y, p.z] as [number, number, number]; })();
            const normal: [number, number, number] = target.hitNormal ?? [0, 1, 0];
            // Don't attach to node — position is world-space and static
            const ann = this.addAnnotation(
              pos,
              normal,
              '',
              DEFAULT_COLOR,
              undefined,  // no node attachment for context menu annotations
            );
            // Open edit modal immediately so user can type text
            this.openEditModal(ann.id);
          },
        },
      ],
    });

    // Bind canvas events
    const canvas = viewer.renderer.domElement;
    this._onPointerDown = (e: PointerEvent) => this._handlePointerDown(e);
    this._onPointerMove = (e: PointerEvent) => this._handlePointerMove(e);
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
  }

  onModelCleared(): void {
    this._cleanup();
  }

  onRender(): void {
    this._renderer?.updateLOD();
    this._updateNodeAttachments();
  }

  dispose(): void {
    this._cleanup();
  }

  // ── Private ─────────────────────────────────────────────────────────

  private _cleanup(): void {
    if (this._viewer) {
      const canvas = this._viewer.renderer.domElement;
      if (this._onPointerDown) canvas.removeEventListener('pointerdown', this._onPointerDown);
      if (this._onPointerMove) canvas.removeEventListener('pointermove', this._onPointerMove);
    }
    this._renderer?.disposeAll();
    this._renderer = null;
    this._annotations = [];
    this._annotationMode = false;
    this._selectedAnnotation = null;
    this._drawingMode = false;
    this._drawingPoints = [];
    this._viewer = null;
    this._syncSend = null;
    this._emitSnapshot();
  }

  private _handlePointerDown(e: PointerEvent): void {
    if (!this._viewer) return;
    if (e.button !== 0) return; // Left click only

    // Drawing mode: accumulate points on pointerdown
    if (this._drawingMode && this._annotationMode) {
      const hit = this._worldRaycast(e);
      if (hit) {
        this._drawingPoints.push([hit.point.x, hit.point.y, hit.point.z]);
        // We complete drawing on double-click or when mode is toggled off
        if (this._drawingPoints.length >= 2 && e.detail >= 2) {
          // Double-click finishes drawing
          this.addDrawing([...this._drawingPoints]);
          this._drawingPoints = [];
        }
      }
      return;
    }

    if (this._annotationMode) {
      // Try to select existing annotation first
      const annotationHit = this._annotationRaycast(e);
      if (annotationHit) {
        this.selectedAnnotation = annotationHit;
        return;
      }

      // Place new annotation
      const hit = this._worldRaycast(e);
      if (hit) {
        const pos: [number, number, number] = [hit.point.x, hit.point.y, hit.point.z];
        const normal: [number, number, number] = hit.normal
          ? [hit.normal.x, hit.normal.y, hit.normal.z]
          : [0, 1, 0];

        // Check if hit mesh belongs to an RV node
        let nodePath: string | undefined;
        if (this._viewer?.registry) {
          const node = this._findRVNode(hit.object);
          if (node) {
            nodePath = this._viewer.registry.getPathForNode(node) ?? undefined;
          }
        }

        this.addAnnotation(pos, normal, 'New annotation', DEFAULT_COLOR, nodePath);
      }
    } else {
      // Not in annotation mode: check if clicking on an annotation to select it
      const annotationHit = this._annotationRaycast(e);
      if (annotationHit) {
        this.selectedAnnotation = annotationHit;
      } else if (this._selectedAnnotation) {
        this.selectedAnnotation = null;
      }
    }
  }

  private _handlePointerMove(_e: PointerEvent): void {
    // Placeholder for ghost pin preview (future enhancement)
  }

  private _worldRaycast(e: PointerEvent): { point: Vector3; normal: Vector3 | null; object: Object3D } | null {
    if (!this._viewer) return null;

    const canvas = this._viewer.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this._worldRaycaster.setFromCamera(this._pointer, this._viewer.camera);
    // Cast against all visible meshes on layer 0
    this._worldRaycaster.layers.set(0);
    const intersects = this._worldRaycaster.intersectObjects(this._viewer.scene.children, true);

    for (const hit of intersects) {
      if (!hit.object.visible) continue;
      // Skip the annotation group itself
      if (this._isAnnotationObject(hit.object)) continue;
      // Skip kinematic merge chunks — annotations should not attach to merged geometry
      if (hit.object.userData?._rvKinGroupMerged) continue;
      return {
        point: hit.point,
        normal: hit.face?.normal?.clone().transformDirection(hit.object.matrixWorld) ?? null,
        object: hit.object,
      };
    }
    return null;
  }

  private _annotationRaycast(e: PointerEvent): string | null {
    if (!this._viewer || !this._renderer) return null;

    const canvas = this._viewer.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    this._annotationRaycaster.setFromCamera(this._pointer, this._viewer.camera);
    this._annotationRaycaster.layers.set(ANNOTATION_LAYER);

    const objects = this._renderer.getInteractiveObjects();
    const intersects = this._annotationRaycaster.intersectObjects(objects, false);

    for (const hit of intersects) {
      const id = this._renderer.getAnnotationIdFromObject(hit.object);
      if (id) return id;
    }
    return null;
  }

  private _isAnnotationObject(obj: Object3D): boolean {
    let current: Object3D | null = obj;
    while (current) {
      if (current === this._renderer?.group) return true;
      current = current.parent;
    }
    return false;
  }

  private _findRVNode(obj: Object3D): Object3D | null {
    let current: Object3D | null = obj;
    while (current) {
      if (current.userData?.['rv_type']) return current;
      current = current.parent;
    }
    return null;
  }

  private _updateNodeAttachments(): void {
    // Node-attached annotations are for moving parts (robot arms, grippers).
    // The stored position is in WORLD space. On each frame we check if the
    // attached node has moved and update the annotation's visual position.
    // For static parts (conveyors, fences) this is a no-op since they don't move.
    if (!this._viewer?.registry || !this._renderer) return;

    for (const ann of this._annotations) {
      if (!ann.nodePath) continue;
      // Annotation position is already in world space — no conversion needed
      // for static nodes. Node attachment is only useful for moving nodes
      // where we'd need to track relative offset. For now, annotations stay
      // at their original world position.
    }
  }

  private _getAuthorName(): string {
    // Try to get from multiuser plugin
    if (this._viewer) {
      const mu = this._viewer.getPlugin('multiuser') as { localName: string } | undefined;
      if (mu?.localName) return mu.localName;
    }
    return 'User';
  }

  // ── Persistence ──────────────────────────────────────────────────────

  private _computeModelHash(result: LoadResult): string {
    // Simple hash from drive count + names
    const names = result.drives.map(d => d.name).sort().join(',');
    let hash = 0;
    for (let i = 0; i < names.length; i++) {
      hash = ((hash << 5) - hash + names.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }

  private _save(): void {
    try {
      const key = LS_PREFIX + this._modelHash;
      const data = JSON.stringify(this._annotations);
      localStorage.setItem(key, data);
    } catch (e) {
      // QuotaExceededError — gracefully ignore
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        console.warn('[AnnotationPlugin] localStorage quota exceeded, annotations not saved');
      }
    }
  }

  private _load(): void {
    try {
      const key = LS_PREFIX + this._modelHash;
      const data = localStorage.getItem(key);
      if (!data) return;

      const parsed = JSON.parse(data) as Annotation[];
      if (!Array.isArray(parsed)) return;

      // Batch creation for performance with many annotations
      const batchSize = 50;
      let idx = 0;

      const processBatch = () => {
        const end = Math.min(idx + batchSize, parsed.length, MAX_ANNOTATIONS);
        for (; idx < end; idx++) {
          const ann = parsed[idx];
          if (!ann.id || !ann.position) continue;
          ann.text = ann.text.substring(0, MAX_TEXT_LENGTH);
          this._annotations.push(ann);
          if (ann.points) {
            this._renderer?.addDrawing(ann);
          } else {
            this._renderer?.addAnnotation(ann);
          }
        }
        this._emitSnapshot();

        if (idx < parsed.length && idx < MAX_ANNOTATIONS) {
          if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(processBatch);
          } else {
            setTimeout(processBatch, 0);
          }
        }
      };

      processBatch();
    } catch {
      // Corrupt localStorage — ignore
    }
  }

  private _bulkApply(annotations: Annotation[]): void {
    // Clear existing
    for (const ann of this._annotations) {
      this._renderer?.removeAnnotation(ann.id);
    }
    this._annotations = [];

    // Apply all remote annotations
    for (const ann of annotations) {
      if (this._annotations.length >= MAX_ANNOTATIONS) break;
      ann.text = ann.text.substring(0, MAX_TEXT_LENGTH);
      this._annotations.push(ann);
      if (ann.points) {
        this._renderer?.addDrawing(ann);
      } else {
        this._renderer?.addAnnotation(ann);
      }
    }
    this._save();
    this._emitSnapshot();
  }

  // ── Drawing mode ────────────────────────────────────────────────────

  /** Toggle drawing mode (subset of annotation mode). */
  toggleDrawingMode(): void {
    this._drawingMode = !this._drawingMode;
    if (this._drawingMode) {
      this._annotationMode = true;
      this._drawingPoints = [];
    } else {
      // Finish current drawing if there are points
      if (this._drawingPoints.length >= 2) {
        this.addDrawing([...this._drawingPoints]);
      }
      this._drawingPoints = [];
    }
    this._emitSnapshot();
  }

  // ── Snapshot emission ───────────────────────────────────────────────

  private _editingAnnotationId: string | null = null;

  /** Open the edit modal for an annotation. */
  openEditModal(id: string): void {
    this._editingAnnotationId = id;
    this.selectedAnnotation = id;
    this._emitSnapshot();
  }

  /** Close the edit modal. */
  closeEditModal(): void {
    this._editingAnnotationId = null;
    this._emitSnapshot();
  }

  private _emitSnapshot(): void {
    _snapshot = {
      annotations: [...this._annotations],
      annotationMode: this._annotationMode,
      selectedAnnotation: this._selectedAnnotation,
      drawingMode: this._drawingMode,
      editingAnnotationId: this._editingAnnotationId,
    };
    notifyListeners();
    this._viewer?.markRenderDirty();
  }
}

// ── Utilities ─────────────────────────────────────────────────────────

function fallbackUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
