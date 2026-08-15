// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-718 §9.7 (vitest half) + §1.6b — the two places the WEB side meets
 * CONNECT's stage-1 contract:
 *
 *  - `GET /config/profiles` lost `model` as its binding and gained
 *    `connectRef` / `documents`. The client has to render both generations,
 *    because `model` is served deprecated for one more release and an older
 *    gateway serves nothing else.
 *  - `connect/migration-bindings.json` is the handoff CONNECT writes and this
 *    side adopts into `documents[].connectRef` — the split that keeps the
 *    single-author rule intact across a migration that crosses it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeProfileBinding,
  fetchProfiles,
  setServerUrl,
  type ConnectProfileInfo,
} from '../src/core/hmi/connect-store';
import {
  CONNECT_MIGRATION_HANDOFF,
  CONNECT_REF_MIGRATION_MARKER,
  migrateConnectRefs,
  parseConnectMigrationHandoff,
  readConnectRefMigrationMarker,
  rollbackConnectRefMigration,
} from '../src/core/project/rv-project-connect-ref-migration';
import type { RvProject } from '../src/core/project/rv-project-types';

afterEach(() => {
  vi.restoreAllMocks();
});

function mockProfiles(body: unknown): void {
  setServerUrl('http://localhost:5100');
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/config/profiles')) {
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  });
}

describe('/config/profiles contract (plan-718 K12)', () => {
  it('reads the reference form a project-scoped gateway serves', async () => {
    mockProfiles({
      active: 'linie-1',
      projectScoped: true,
      profiles: [{
        name: 'linie-1',
        connectRef: 'connect/linie-1.connect.json',
        documents: ['models/linie1.glb', 'models/linie1-detail.glb'],
        model: null,
        interfaceCount: 2,
        mirrorCount: 0,
        mappingCount: 1,
      }],
    });

    const res = await fetchProfiles();
    expect(res.projectScoped).toBe(true);
    expect(res.profiles[0].connectRef).toBe('connect/linie-1.connect.json');
    // N:1 — one configuration file, two documents. The UI has to say so.
    expect(res.profiles[0].documents).toEqual(['models/linie1.glb', 'models/linie1-detail.glb']);
    expect(describeProfileBinding(res.profiles[0]))
      .toBe('models/linie1.glb, models/linie1-detail.glb');
  });

  it('still reads an older gateway that only knows model', async () => {
    mockProfiles({
      active: 'cell1',
      profiles: [{ name: 'cell1', model: 'models/Cell1.glb', interfaceCount: 1, mirrorCount: 0, mappingCount: 0 }],
    });

    const res = await fetchProfiles();
    expect(res.projectScoped).toBe(false);
    // Normalised so no caller has to know which generation answered.
    expect(res.profiles[0].documents).toEqual([]);
    expect(describeProfileBinding(res.profiles[0])).toBe('models/Cell1.glb');
  });

  it('reports no binding at all for an unbound profile', () => {
    const profile: ConnectProfileInfo = {
      name: 'manual', interfaceCount: 0, mirrorCount: 0, mappingCount: 0, documents: [],
    };
    expect(describeProfileBinding(profile)).toBeNull();
  });
});

describe('CONNECT migration handoff (plan-718 §1.6b)', () => {
  const project = (): RvProject => ({
    schemaVersion: 2,
    id: 'prj_1',
    name: 'Werk Nord',
    documents: [
      { id: 'ast_a', path: 'models/Cell1.glb', name: 'Cell 1' },
      { id: 'ast_b', path: 'models/cell2.glb', name: 'Cell 2' },
      { id: 'ast_c', path: 'models/versand.glb', name: 'Versand' },
    ],
  } as unknown as RvProject);

  it('parses the PascalCase record CONNECT serialises', () => {
    const bindings = parseConnectMigrationHandoff(JSON.stringify({
      bindings: [
        { Model: 'models/Cell1.glb', ConnectRef: 'connect/cell1.connect.json', Profile: 'cell1' },
        { model: 'cell2', connectRef: 'connect/cell2.connect.json' },
        { Model: '', ConnectRef: 'connect/x.json' },
      ],
    }));
    expect(bindings).toHaveLength(2);
    expect(bindings[0].connectRef).toBe('connect/cell1.connect.json');
    expect(bindings[1].model).toBe('cell2');
  });

  it('is unbothered by a handoff it cannot read', () => {
    expect(parseConnectMigrationHandoff('{ not json')).toEqual([]);
    expect(parseConnectMigrationHandoff(null)).toEqual([]);
    expect(parseConnectMigrationHandoff({ bindings: 'nope' })).toEqual([]);
  });

  it('binds through the legacy model comparison, then never uses it again', () => {
    const res = migrateConnectRefs(project(), [
      { model: 'models/Cell1.glb', connectRef: 'connect/cell1.connect.json' },
      { model: 'CELL2.glb', connectRef: 'connect/cell2.connect.json' },
    ], { now: () => '2026-08-14T00:00:00.000Z' });

    expect(res.outcome).toBe('migrated');
    expect(res.project.documents?.[0].connectRef).toBe('connect/cell1.connect.json');
    // Case-insensitive on the way in, because that is what CONNECT did.
    expect(res.project.documents?.[1].connectRef).toBe('connect/cell2.connect.json');
    expect(res.project.documents?.[2].connectRef).toBeUndefined();
    expect(readConnectRefMigrationMarker(res.project)?.assignedIds).toEqual(['ast_a', 'ast_b']);
  });

  it('is idempotent — a second run is `already`, not a second write', () => {
    const once = migrateConnectRefs(project(), [
      { model: 'Cell1', connectRef: 'connect/cell1.connect.json' },
    ]);
    const twice = migrateConnectRefs(once.project, [
      { model: 'Cell1', connectRef: 'connect/cell1.connect.json' },
    ]);
    expect(twice.outcome).toBe('already');
    expect(twice.project).toBe(once.project);
  });

  it('never overwrites an authored connectRef', () => {
    const authored = project();
    authored.documents![0].connectRef = 'connect/by-hand.connect.json';
    const res = migrateConnectRefs(authored, [
      { model: 'Cell1', connectRef: 'connect/cell1.connect.json' },
    ]);
    expect(res.outcome).toBe('skipped');
    expect(res.project.documents?.[0].connectRef).toBe('connect/by-hand.connect.json');
  });

  it('reports an unmatched binding instead of guessing at one', () => {
    const res = migrateConnectRefs(project(), [
      { model: 'a-model-nobody-registered', connectRef: 'connect/x.connect.json' },
    ]);
    expect(res.assigned).toEqual([]);
    expect(res.unmatched).toEqual(['a-model-nobody-registered']);
  });

  it('refuses a handoff reference that leaves the project', () => {
    const res = migrateConnectRefs(project(), [
      { model: 'Cell1', connectRef: '../outside/steal.connect.json' },
    ]);
    expect(res.assigned).toEqual([]);
    expect(res.unmatched).toEqual(['Cell1']);
  });

  it('rolls back exactly the rows it wrote', () => {
    const migrated = migrateConnectRefs(project(), [
      { model: 'Cell1', connectRef: 'connect/cell1.connect.json' },
    ]).project;
    const back = rollbackConnectRefMigration(migrated);
    expect(back.documents?.[0].connectRef).toBeUndefined();
    expect(back[CONNECT_REF_MIGRATION_MARKER]).toBeUndefined();
  });

  it('names the handoff CONNECT actually writes', () => {
    // Both sides hardcode this path; a drift here is a migration that silently never runs.
    expect(CONNECT_MIGRATION_HANDOFF).toBe('connect/migration-bindings.json');
  });
});
