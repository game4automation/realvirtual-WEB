// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-folder-writer.test — the write path, where the data can die.
 *
 * Four things are load-bearing and each has its own block:
 *  - every mutation seam reaches disk (§4d — a hook in save() alone missed
 *    five of them);
 *  - bodies are written before the manifest, so the manifest never points at
 *    a file that is not there;
 *  - the RR1 guard refuses a path that belongs to a different scene, rather
 *    than overwriting or deleting it;
 *  - a failed disk write leaves the project visibly unsaved (§4e) — the one
 *    outcome this whole plan exists to prevent is "UI says saved, folder is
 *    old".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeDir, FailureInjector, asDirHandle, namedError } from './helpers/fake-fs-handles';
import { RVProjectFolderWriter } from '../src/core/project/rv-project-folder-writer';
import { clearSceneMutationListeners, emitSceneMutation } from '../src/core/hmi/scene/rv-scene-mutations';
import { sceneRelPathFor, type RvProject } from '../src/core/project/rv-project-types';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';

// ─── Fixtures ───────────────────────────────────────────────────────────

const scene = (id: string, name: string): RvScene => ({
  id,
  name,
  createdAt: '2025-01-01T00:00:00.000Z',
  modifiedAt: '2025-01-01T00:00:00.000Z',
  schemaVersion: 2,
  base: { kind: 'empty' },
  edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
});

const DEBOUNCE = 5;   // short and real — no fake timers needed for 5 ms

interface Harness {
  root: FakeDir;
  failures: FailureInjector;
  writer: RVProjectFolderWriter;
  manifest: RvProject;
  bodies: Map<string, RvScene>;
  settle(): Promise<void>;
}

function makeHarness(initial?: Partial<RvProject>, writable = true): Harness {
  const failures = new FailureInjector();
  const root = new FakeDir('project', failures);
  const bodies = new Map<string, RvScene>();
  const h = {
    root,
    failures,
    bodies,
    manifest: { schemaVersion: 1, id: 'prj_1', name: 'Demo', scenes: [], ...initial } as RvProject,
  } as Harness;

  h.writer = new RVProjectFolderWriter(
    {
      getDirectory: () => (writable ? asDirHandle(root) : null),
      getManifest: () => h.manifest,
      setManifest: p => { h.manifest = p; },
      readScene: id => bodies.get(id) ?? null,
      collectSettings: () => ({ $schema: 'rv-settings-bundle/1.0', settings: {} }),
    },
    DEBOUNCE,
  );
  h.settle = async () => { await h.writer.flush(); };
  h.writer.start();
  return h;
}

let harnesses: RVProjectFolderWriter[] = [];

function track(h: Harness): Harness {
  harnesses.push(h.writer);
  return h;
}

beforeEach(() => {
  clearSceneMutationListeners();
  harnesses = [];
});

afterEach(() => {
  for (const w of harnesses) w.dispose();
  clearSceneMutationListeners();
});

async function manifestOnDisk(root: FakeDir): Promise<RvProject> {
  return JSON.parse((await root.readText('project.json'))!);
}

// ─── All mutation seams reach disk (§4d) ────────────────────────────────

describe('mutation seams', () => {
  it('an upsert writes the body and registers it in the manifest', async () => {
    const h = track(makeHarness());
    const s = scene('scn_a', 'Cell A');
    h.bodies.set(s.id, s);

    emitSceneMutation({ type: 'upsert', id: s.id, scene: s });
    await h.settle();

    const path = sceneRelPathFor(s);
    expect(await h.root.readTextAt('scenes', path.split('/')[1])).toContain('"scn_a"');
    const m = await manifestOnDisk(h.root);
    expect(m.scenes!.map(e => e.id)).toEqual(['scn_a']);
    expect(m.scenes![0].path).toBe(path);
  });

  it('a rename writes the new file and retires the old one', async () => {
    const h = track(makeHarness());
    const before = scene('scn_a', 'Cell A');
    h.bodies.set(before.id, before);
    emitSceneMutation({ type: 'upsert', id: before.id, scene: before });
    await h.settle();
    const oldFile = sceneRelPathFor(before).split('/')[1];
    expect(await h.root.readTextAt('scenes', oldFile)).not.toBeNull();

    const after = { ...before, name: 'Cell B' };
    h.bodies.set(after.id, after);
    emitSceneMutation({ type: 'rename', id: after.id, scene: after, prevName: 'Cell A' });
    await h.settle();

    const newFile = sceneRelPathFor(after).split('/')[1];
    expect(newFile).not.toBe(oldFile);
    expect(await h.root.readTextAt('scenes', newFile)).not.toBeNull();
    expect(await h.root.readTextAt('scenes', oldFile)).toBeNull();
    const m = await manifestOnDisk(h.root);
    expect(m.scenes!).toHaveLength(1);
    expect(m.scenes![0].name).toBe('Cell B');
  });

  it('a duplicate (upsert of a second id) lands on disk as its own file', async () => {
    const h = track(makeHarness());
    for (const s of [scene('scn_a', 'A'), scene('scn_b', 'A (copy)')]) {
      h.bodies.set(s.id, s);
      emitSceneMutation({ type: 'upsert', id: s.id, scene: s });
    }
    await h.settle();
    const m = await manifestOnDisk(h.root);
    expect(m.scenes!.map(e => e.id).sort()).toEqual(['scn_a', 'scn_b']);
    expect(new Set(m.scenes!.map(e => e.path)).size).toBe(2);
  });

  it('a delete removes the file and the manifest entry', async () => {
    const h = track(makeHarness());
    const s = scene('scn_a', 'A');
    h.bodies.set(s.id, s);
    emitSceneMutation({ type: 'upsert', id: s.id, scene: s });
    await h.settle();

    emitSceneMutation({ type: 'delete', id: s.id });
    await h.settle();

    expect(await h.root.readTextAt('scenes', sceneRelPathFor(s).split('/')[1])).toBeNull();
    expect((await manifestOnDisk(h.root)).scenes).toEqual([]);
  });

  it('an active-id change is mirrored into the manifest', async () => {
    const h = track(makeHarness());
    localStorage.setItem('rv-scenes/active', JSON.stringify({ id: 'scn_a' }));
    emitSceneMutation({ type: 'active', id: 'scn_a' });
    await h.settle();
    expect((await manifestOnDisk(h.root)).activeSceneId).toBe('scn_a');

    localStorage.removeItem('rv-scenes/active');
    emitSceneMutation({ type: 'active', id: null });
    await h.settle();
    expect((await manifestOnDisk(h.root)).activeSceneId).toBeNull();
  });

  it('the autosave draft tick never reaches disk (it emits no mutation)', async () => {
    const h = track(makeHarness());
    // The draft path calls writeSceneDraft() and deliberately does NOT emit.
    // Nothing scheduled ⇒ nothing written.
    await h.settle();
    expect(await h.root.readText('project.json')).toBeNull();
    expect(h.root.has('scenes')).toBe(false);
  });

  it('a delete for an id the manifest never knew touches nothing (R2)', async () => {
    const h = track(makeHarness());
    emitSceneMutation({ type: 'delete', id: 'scn_not_ours' });
    await h.settle();
    expect(h.root.has('scenes')).toBe(false);
    expect(await h.root.readText('project.json')).toBeNull();
  });
});

// ─── Ordering + coalescing ──────────────────────────────────────────────

describe('ordering and coalescing', () => {
  it('writes bodies BEFORE the manifest', async () => {
    const h = track(makeHarness());
    const s = scene('scn_a', 'A');
    h.bodies.set(s.id, s);

    const order: string[] = [];
    const origin = h.failures.check.bind(h.failures);
    h.failures.check = (point, name) => { order.push(`${point}:${name}`); origin(point, name); };

    emitSceneMutation({ type: 'upsert', id: s.id, scene: s });
    await h.settle();

    const bodyIdx = order.findIndex(e => e.endsWith('.scene.json'));
    const manifestIdx = order.findIndex(e => e.endsWith('project.json'));
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(manifestIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeLessThan(manifestIdx);
  });

  it('coalesces a burst of mutations into a single manifest write', async () => {
    const h = track(makeHarness());
    const spy = vi.fn();
    const origin = h.failures.check.bind(h.failures);
    h.failures.check = (point, name) => {
      if (point === 'write' && name === 'project.json') spy();
      origin(point, name);
    };

    for (let i = 0; i < 5; i++) {
      const s = scene(`scn_${i}`, `S${i}`);
      h.bodies.set(s.id, s);
      emitSceneMutation({ type: 'upsert', id: s.id, scene: s });
    }
    await h.settle();

    expect(spy).toHaveBeenCalledTimes(1);
    expect((await manifestOnDisk(h.root)).scenes).toHaveLength(5);
  });

  it('flush() writes work that is still inside the debounce window', async () => {
    const h = track(makeHarness());
    const s = scene('scn_a', 'A');
    h.bodies.set(s.id, s);
    emitSceneMutation({ type: 'upsert', id: s.id, scene: s });

    // No waiting for the timer — this is the tab-close path.
    await h.writer.flush();
    expect((await manifestOnDisk(h.root)).scenes).toHaveLength(1);
  });

  it('flush() on an empty queue is a no-op', async () => {
    const h = track(makeHarness());
    await expect(h.writer.flush()).resolves.toBeUndefined();
    expect(await h.root.readText('project.json')).toBeNull();
  });

  it('preserves unknown manifest sections across a write', async () => {
    const h = track(makeHarness({ futureThing: { keep: true } } as Partial<RvProject>));
    const s = scene('scn_a', 'A');
    h.bodies.set(s.id, s);
    emitSceneMutation({ type: 'upsert', id: s.id, scene: s });
    await h.settle();
    expect((await manifestOnDisk(h.root)).futureThing).toEqual({ keep: true });
  });
});

// ─── RR1 guard ──────────────────────────────────────────────────────────

describe('RR1 — the writer refuses to touch a path it does not own', () => {
  it('two identically-named scenes get two files, not one', async () => {
    const h = track(makeHarness());
    const a = scene('scn_aaa', 'Cell');
    const b = scene('scn_bbb', 'Cell');
    h.bodies.set(a.id, a);
    h.bodies.set(b.id, b);
    emitSceneMutation({ type: 'upsert', id: a.id, scene: a });
    emitSceneMutation({ type: 'upsert', id: b.id, scene: b });
    await h.settle();

    const m = await manifestOnDisk(h.root);
    expect(new Set(m.scenes!.map(e => e.path)).size).toBe(2);
    expect(h.root.childNames()).toContain('scenes');
    const scenesDir = await h.root.readTextAt('scenes', sceneRelPathFor(a).split('/')[1]);
    expect(scenesDir).toContain('"scn_aaa"');
    expect(await h.root.readTextAt('scenes', sceneRelPathFor(b).split('/')[1])).toContain('"scn_bbb"');
  });

  it('refuses a write onto a path another manifest entry claims', async () => {
    const stolen = sceneRelPathFor({ id: 'scn_a', name: 'Cell' });
    const h = track(makeHarness({
      // A hand-edited/corrupt manifest where scn_b already owns scn_a's path.
      scenes: [{ id: 'scn_b', name: 'Other', path: stolen }],
    }));
    const a = scene('scn_a', 'Cell');
    h.bodies.set(a.id, a);
    h.root.seedDir('scenes').seedText(stolen.split('/')[1], '{"owner":"scn_b"}');

    emitSceneMutation({ type: 'upsert', id: a.id, scene: a });
    await h.settle();

    // The other scene's file is untouched, and the failure is visible.
    expect(await h.root.readTextAt('scenes', stolen.split('/')[1])).toBe('{"owner":"scn_b"}');
    expect(h.writer.getStatus().error).toContain('already belongs to scene scn_b');
  });

  it('refuses a delete of a path the manifest attributes to another scene', async () => {
    const path = sceneRelPathFor({ id: 'scn_a', name: 'Cell' });
    const h = track(makeHarness({ scenes: [{ id: 'scn_a', name: 'Cell', path }] }));
    h.root.seedDir('scenes').seedText(path.split('/')[1], '{"owner":"scn_a"}');

    // The manifest records a *different* path for scn_a than the writer holds.
    h.manifest = { ...h.manifest, scenes: [{ id: 'scn_a', name: 'Cell', path: 'scenes/elsewhere.scene.json' }] };
    emitSceneMutation({ type: 'delete', id: 'scn_a' });
    await h.settle();

    expect(await h.root.readTextAt('scenes', path.split('/')[1])).toBe('{"owner":"scn_a"}');
  });

  it('refuses a delete for a scene that is not in the manifest at all', async () => {
    const path = sceneRelPathFor({ id: 'scn_x', name: 'X' });
    const h = track(makeHarness({ scenes: [{ id: 'scn_x', name: 'X', path }] }));
    h.root.seedDir('scenes').seedText(path.split('/')[1], 'body');

    // Drop it from the manifest *after* the writer captured the path.
    emitSceneMutation({ type: 'delete', id: 'scn_x' });
    h.manifest = { ...h.manifest, scenes: [] };
    await h.settle();

    expect(await h.root.readTextAt('scenes', path.split('/')[1])).toBe('body');
    expect(h.writer.getStatus().error).toContain('not in the manifest');
  });
});

// ─── §4e failure paths ──────────────────────────────────────────────────

describe('§4e — a failed disk write is never reported as saved', () => {
  it('a body write failure sets a persistent error and keeps the work queued', async () => {
    const h = track(makeHarness());
    const s = scene('scn_a', 'A');
    h.bodies.set(s.id, s);
    // Disk full: a plain I/O failure, NOT an invalidated handle.
    h.failures.fail({
      point: 'write',
      name: sceneRelPathFor(s).split('/')[1],
      error: namedError('QuotaExceededError', 'disk is full'),
    });

    emitSceneMutation({ type: 'upsert', id: s.id, scene: s });
    await h.settle();

    const status = h.writer.getStatus();
    expect(status.error).toContain('Not saved to disk');
    expect(status.handleInvalid).toBe(false);
    expect(status.pending).toBe(true);
    expect(h.writer.isDirty()).toBe(true);
    expect(await h.root.readText('project.json')).toBeNull();  // manifest never written
  });

  it('a retry after the failure clears succeeds and clears the error', async () => {
    const h = track(makeHarness());
    const s = scene('scn_a', 'A');
    h.bodies.set(s.id, s);
    h.failures.fail({
      point: 'write',
      name: sceneRelPathFor(s).split('/')[1],
      error: namedError('QuotaExceededError', 'disk is full'),
      times: 1,
    });

    emitSceneMutation({ type: 'upsert', id: s.id, scene: s });
    await h.settle();
    expect(h.writer.getStatus().error).toBeTruthy();

    await h.writer.flush();   // the queued work is retried
    expect(h.writer.getStatus().error).toBeNull();
    expect(h.writer.isDirty()).toBe(false);
    expect((await manifestOnDisk(h.root)).scenes).toHaveLength(1);
  });

  it('an invalidated handle is reported as such, not looped on', async () => {
    const h = track(makeHarness());
    const s = scene('scn_a', 'A');
    h.bodies.set(s.id, s);
    h.failures.fail({ point: 'getDirectory', name: 'scenes' });

    emitSceneMutation({ type: 'upsert', id: s.id, scene: s });
    await h.settle();

    const status = h.writer.getStatus();
    expect(status.handleInvalid).toBe(true);
    expect(status.error).toContain('no longer writable');
    expect(status.error).toContain('Re-open it');
  });

  it('a read-only project says so instead of pretending to save', async () => {
    const h = track(makeHarness(undefined, /* writable */ false));
    const s = scene('scn_a', 'A');
    h.bodies.set(s.id, s);

    emitSceneMutation({ type: 'upsert', id: s.id, scene: s });
    await h.settle();

    expect(h.writer.getStatus().error).toContain('not writable');
    expect(h.writer.isDirty()).toBe(true);
  });

  it('a status listener sees the failure', async () => {
    const h = track(makeHarness());
    const seen: (string | null)[] = [];
    h.writer.onStatus(st => seen.push(st.error));
    const s = scene('scn_a', 'A');
    h.bodies.set(s.id, s);
    h.failures.fail({
      point: 'write',
      name: sceneRelPathFor(s).split('/')[1],
      error: namedError('QuotaExceededError', 'disk is full'),
    });

    emitSceneMutation({ type: 'upsert', id: s.id, scene: s });
    await h.settle();

    expect(seen.some(e => e?.includes('Not saved to disk'))).toBe(true);
  });

  it('a vanished body is skipped quietly rather than written truncated', async () => {
    const h = track(makeHarness());
    emitSceneMutation({ type: 'upsert', id: 'scn_gone', scene: scene('scn_gone', 'Gone') });
    await h.settle();   // no body in the map
    expect(h.root.has('scenes')).toBe(false);
    expect(h.writer.getStatus().error).toBeNull();
  });
});

// ─── Lifecycle ──────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('stop() detaches from the bus', async () => {
    const h = track(makeHarness());
    h.writer.stop();
    const s = scene('scn_a', 'A');
    h.bodies.set(s.id, s);
    emitSceneMutation({ type: 'upsert', id: s.id, scene: s });
    await h.settle();
    expect(await h.root.readText('project.json')).toBeNull();
  });

  it('dispose() drops queued work and ignores further mutations', async () => {
    const h = track(makeHarness());
    h.writer.dispose();
    emitSceneMutation({ type: 'upsert', id: 'scn_a', scene: scene('scn_a', 'A') });
    await h.writer.flush();
    expect(await h.root.readText('project.json')).toBeNull();
  });

  it('start() is idempotent — one subscription, one write', async () => {
    const h = track(makeHarness());
    h.writer.start();
    h.writer.start();
    const spy = vi.fn();
    const origin = h.failures.check.bind(h.failures);
    h.failures.check = (point, name) => {
      if (point === 'write' && name === 'project.json') spy();
      origin(point, name);
    };
    const s = scene('scn_a', 'A');
    h.bodies.set(s.id, s);
    emitSceneMutation({ type: 'upsert', id: s.id, scene: s });
    await h.settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
