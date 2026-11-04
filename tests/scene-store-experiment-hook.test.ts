// SPDX-License-Identifier: AGPL-3.0-only
import { it, expect, afterEach } from 'vitest';
import { SceneStore, setDocumentExperimentSyncHook } from '../src/core/hmi/scene/scene-store';
import type { RVViewer } from '../src/core/rv-viewer';
import { installFakeDocumentProject } from './helpers/fake-document-project';
const stores: SceneStore[] = [];
afterEach(async () => { await setDocumentExperimentSyncHook(null); for (const s of stores.splice(0)) s.dispose(); });
function store() {
 const s = new SceneStore({} as RVViewer); stores.push(s);
 const state = s as unknown as { _workspace: { documentId: string }; _replaceGeneration: number };
 state._workspace = { documentId: 'first' };
 return { s, state };
}
it('without a hook leaves opaque experiment bytes untouched on open and save', async () => {
 const { s } = store();
 const bytes = new TextEncoder().encode('{"opaque":true}\r\n');
 const before = bytes.slice();
 const project = installFakeDocumentProject({ files: { 'experiments/opaque.rvexp.ndjson': bytes } });
 try {
 await s.syncOpenDocumentExperiments();
 await (s as unknown as { _syncDocumentExperiments(id: string, action: string): Promise<void> })._syncDocumentExperiments('first', 'save');
 expect(project.files.get('experiments/opaque.rvexp.ndjson')).toEqual(before);
 expect(project.writes).toEqual([]);
 } finally { project.restore(); }
});
it('catches up on late installation and invalidates in-flight work on document replacement', async () => {
 const { s, state } = store(); let valid!: () => boolean; let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 const pending = setDocumentExperimentSyncHook(async (_viewer, id, action, current) => {
  expect(id).toBe('first'); expect(action).toBe('open'); valid = current; await gate;
 });
 expect(valid()).toBe(true);
 state._replaceGeneration++; state._workspace.documentId = 'second';
 expect(valid()).toBe(false); release(); await pending;
});
