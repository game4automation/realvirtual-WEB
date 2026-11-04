// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The live {@link DocumentNavHost}: the viewer, the project and scene stores,
 * the document-mode store and the dashboard's editor handoff. Kept apart from
 * `document-nav.ts` so the navigation rules stay testable without any of them.
 */

import { Vector3 } from 'three';
import type { RVViewer } from '../rv-viewer';
import { getProjectStore } from '../project/project-store';
import { readDocumentMode } from '../project/rv-document-mode-store';
import { getOpenDocumentBase } from '../editor/active-asset-store';
import { getSceneStore } from './scene/scene-store-singleton';
import { showInstruction } from './instruction-store';
import type { DocumentNavHost, NavCamera } from './document-nav';

export function createDocumentNavHost(viewer: RVViewer): DocumentNavHost {
  return {
    modes: viewer.modes,
    project: () => {
      const snap = getProjectStore().getSnapshot();
      if (!snap.project || !snap.backendKind) return null;
      return {
        id: snap.project.id,
        backend: snap.backendKind,
        name: snap.project.name ?? snap.project.id,
        isDemo: snap.project.kind === 'demo',
        documents: snap.documents,
      };
    },
    openDocument: () => {
      const base = getOpenDocumentBase();
      return base?.kind === 'document' ? { documentId: base.documentId, name: base.name } : null;
    },
    readLastMode: (backend, projectId, documentId) => readDocumentMode(backend, projectId, documentId),
    openAsWorkingScene: async (documentId, token, targetMode) => {
      const sceneStore = getSceneStore();
      if (!sceneStore) return false;
      // The dashboard module is lazy (HMIShell); the handoff lives there.
      const { openDocumentAsWorkingScene } = await import('./projects/ProjectsDashboardHost');
      return openDocumentAsWorkingScene(
        viewer, sceneStore, getProjectStore().getSnapshot().documents, documentId, token, targetMode);
    },
    flushAutosave: async () => { await getSceneStore()?.flushAutosave(); },
    getCamera: () => {
      const { position, target } = viewer.getCameraState();
      return { position: [position.x, position.y, position.z], target: [target.x, target.y, target.z] };
    },
    restoreCamera: async (camera: NavCamera) => {
      await viewer.whenSceneReady();
      viewer.animateCameraTo(new Vector3(...camera.position), new Vector3(...camera.target), 0.35);
    },
    notify: (text) => showInstruction({
      id: 'document-nav',
      text,
      anchor: { kind: 'edge', edge: 'bottom' },
      style: 'toast',
      autoClearAfterMs: 5000,
      source: 'document-nav',
    }),
  };
}
