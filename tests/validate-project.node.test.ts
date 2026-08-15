// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * validate-project on the one list (plan-413 phase 6, F14).
 *
 * The CI gate ran on `scenes[]` / `models[]` / `library[]`. Those arrays became
 * a derived mirror in phase 2 and are on their way out; `documents[]` is the
 * list. The gate had to learn it **before** the mirror can fall, which is the
 * whole ordering constraint of this phase — a validator that silently checked
 * nothing would be worse than one that failed loudly.
 *
 * The three shapes that must all pass through it are pinned here: a migrated
 * manifest (documents only), an unmigrated one (arrays only) and the mixed
 * state every project spends the transition in.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateProject } from '../scripts/validate-project.mjs';

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rv-validate-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A project folder with the given manifest and the given files present. */
function project(manifest: unknown, files: string[] = []): string {
  const dir = join(root, 'acme');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const rel of files) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, 'x');
  }
  return dir;
}

const BASE = {
  schemaVersion: 2, id: 'prj_acme', name: 'Acme', canonicalName: 'acme',
  vendor: { managed: ['models/**'], handover: [] },
};

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'doc_a', name: 'A', path: 'models/a.glb', section: 'models', ...over,
});

describe('documents[] shape', () => {
  it('accepts a migrated manifest whose documents are all present', () => {
    const dir = project({ ...BASE, documents: [doc(), doc({ id: 'doc_s', path: 'scenes/s.scene.glb', section: 'scenes' })] },
      ['models/a.glb', 'scenes/s.scene.glb']);
    const result = validateProject(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings.filter(w => w.includes('not present on disk'))).toEqual([]);
  });

  it('rejects a documents[] that is not an array', () => {
    const result = validateProject(project({ ...BASE, documents: { a: 1 } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('"documents" must be an array'))).toBe(true);
  });

  it('fails a document without an id — F2 is what the identity model rests on', () => {
    const result = validateProject(project({ ...BASE, documents: [{ path: 'models/a.glb' }] },
      ['models/a.glb']));
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes('has no "id"'))).toBe(true);
  });

  it('warns about a document whose file is not there', () => {
    const result = validateProject(project({ ...BASE, documents: [doc()] }));
    expect(result.ok).toBe(true);            // a warning, not a failure
    expect(result.warnings.some(w => w.includes('documents') && w.includes('models/a.glb'))).toBe(true);
  });

  it('refuses a document path that escapes the project', () => {
    for (const path of ['../elsewhere/a.glb', '/abs/a.glb', 'C:/abs/a.glb']) {
      const result = validateProject(project({ ...BASE, documents: [doc({ path })] }));
      expect(result.ok).toBe(false);
      expect(result.errors.some(e => e.includes('must be a relative path'))).toBe(true);
    }
  });

  it('resolves a section-relative document against its own folder', () => {
    // A document that lost its folder prefix is still found, because the
    // section says which folder it belongs to. Reporting it missing would send
    // a delivery engineer looking for a file that is right there.
    const dir = project({ ...BASE, documents: [doc({ path: 'a.glb' })] }, ['models/a.glb']);
    expect(validateProject(dir).warnings.filter(w => w.includes('not present on disk'))).toEqual([]);
  });

  it('checks a stated sha256 on a document, as it always did on models[]', () => {
    const dir = project({
      ...BASE,
      documents: [doc({ sha256: 'a'.repeat(64) })],
    }, ['models/a.glb']);
    expect(validateProject(dir).warnings.some(w => w.includes('sha256 does not match'))).toBe(true);
  });
});

describe('the three transition shapes all pass', () => {
  it('unmigrated: the three legacy arrays and no documents[]', () => {
    const dir = project({
      ...BASE, schemaVersion: 1,
      scenes: [{ id: 'scn_a', path: 'scenes/a.scene.glb' }],
      models: [{ path: 'a.glb' }],
      library: [{ path: 'g.glb' }],
    }, ['scenes/a.scene.glb', 'models/a.glb', 'library/g.glb']);
    const result = validateProject(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings.filter(w => w.includes('not present on disk'))).toEqual([]);
  });

  it('mixed: documents[] beside the mirror it was derived from', () => {
    const dir = project({
      ...BASE,
      documents: [doc({ id: 'doc_m', path: 'models/a.glb' })],
      models: [{ path: 'a.glb', id: 'doc_m' }],
    }, ['models/a.glb']);
    const result = validateProject(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings.filter(w => w.includes('not present on disk'))).toEqual([]);
  });

  it('migrated: documents[] alone, with the arrays gone', () => {
    const dir = project({ ...BASE, documents: [doc()] }, ['models/a.glb']);
    expect(validateProject(dir).ok).toBe(true);
  });
});

/**
 * plan-718 §2.6 / §9.4 / §9.10 — the reference model's own gate.
 *
 * Two severities, and the split is the point: a reference that LEAVES the
 * project is an error (the folder has stopped being copyable, which is the one
 * property the model exists to provide), a reference whose target is missing is
 * a warning (a half-copied working tree is a state, not a broken build).
 */

/** Writes a file with explicit content — the secret cases need real JSON. */
function projectWith(manifest: unknown, files: Record<string, string>): string {
  const dir = join(root, 'acme');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, body);
  }
  return dir;
}

describe('document references (plan-718)', () => {
  it('accepts a project whose three references all resolve', () => {
    const dir = projectWith(
      { ...BASE, documents: [doc({ connectRef: 'connect/a.connect.json', scriptRef: 'plugins/index.ts', knowledgeRef: 'knowledge/a.json' })] },
      {
        'models/a.glb': 'x',
        'connect/a.connect.json': '{"$schema":"rv-connect-config/1.0","Interfaces":[]}',
        'plugins/index.ts': 'export {}',
        'knowledge/a.json': '{}',
      },
    );
    const result = validateProject(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings.filter(w => w.includes('not there'))).toEqual([]);
  });

  it('warns about a DEAD reference — set, but nothing at the other end', () => {
    const dir = projectWith(
      { ...BASE, documents: [doc({ knowledgeRef: 'knowledge/gone.json' })] },
      { 'models/a.glb': 'x' },
    );
    const result = validateProject(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => /knowledgeRef "knowledge\/gone.json".*not there/.test(w))).toBe(true);
  });

  it('FAILS a reference that leaves the project', () => {
    const dir = projectWith(
      { ...BASE, documents: [doc({ connectRef: '../elsewhere/steal.json' })] },
      { 'models/a.glb': 'x' },
    );
    const result = validateProject(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /connectRef .* leaves the project/.test(e))).toBe(true);
  });

  it('FAILS an escaping connect.agentsRef and an escaping connect.secretsRef', () => {
    const dir = projectWith(
      { ...BASE, connect: { agentsRef: '../a.json', secretsRef: '/etc/secrets.json' }, documents: [doc()] },
      { 'models/a.glb': 'x' },
    );
    const result = validateProject(dir);
    expect(result.errors.filter(e => /leaves the project/.test(e))).toHaveLength(2);
  });

  it('FAILS an escaping connect.ragRef and WARNS about a dead one (stage 3.3)', () => {
    const escaping = projectWith(
      { ...BASE, connect: { ragRef: '../outside/rag.zip' }, documents: [doc()] },
      { 'models/a.glb': 'x' },
    );
    expect(validateProject(escaping).errors.some(e => /ragRef .* leaves the project/.test(e)))
      .toBe(true);

    const dead = projectWith(
      { ...BASE, connect: { ragRef: 'knowledge/linie1.zip' }, documents: [doc()] },
      { 'models/a.glb': 'x' },
    );
    const result = validateProject(dead);
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => /ragRef "knowledge\/linie1.zip".*not there/.test(w))).toBe(true);
  });

  it('says nothing about a missing secrets sidecar — it is gitignored by design', () => {
    const dir = projectWith({ ...BASE, documents: [doc()] }, { 'models/a.glb': 'x' });
    const result = validateProject(dir);
    expect(result.warnings.some(w => w.includes('secrets.local.json'))).toBe(false);
  });
});

describe('secrets in committed connect files (plan-718 F3)', () => {
  const connectProject = (body: unknown, extra: Record<string, string> = {}) => projectWith(
    { ...BASE, documents: [doc({ connectRef: 'connect/a.connect.json' })] },
    { 'models/a.glb': 'x', 'connect/a.connect.json': JSON.stringify(body), ...extra },
  );

  it('FAILS a plaintext password, however unremarkable it looks', () => {
    const result = validateProject(connectProject({
      $schema: 'rv-connect-config/1.0',
      Interfaces: [{ Type: 'S7', Settings: { Password: 'hunter2' } }],
    }));
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /plaintext secret/.test(e))).toBe(true);
  });

  it('accepts the two reference forms and an empty value', () => {
    const result = validateProject(connectProject({
      $schema: 'rv-connect-config/1.0',
      Interfaces: [
        { Type: 'S7', Settings: { Password: { $secretRef: 'linie1.plc' } } },
        { Type: 'MQTT', Settings: { Token: '${env:RV_MQTT_TOKEN}', ApiKey: '' } },
      ],
    }));
    expect(result.errors).toEqual([]);
  });

  it('warns when two connect files reach for the SAME secret key', () => {
    const dir = projectWith(
      {
        ...BASE,
        documents: [
          doc({ connectRef: 'connect/a.connect.json' }),
          doc({ id: 'doc_b', path: 'models/b.glb', connectRef: 'connect/b.connect.json' }),
        ],
      },
      {
        'models/a.glb': 'x', 'models/b.glb': 'x',
        'connect/a.connect.json': JSON.stringify({ Settings: { Password: { $secretRef: 'plc.pw' } } }),
        'connect/b.connect.json': JSON.stringify({ Settings: { Password: { $secretRef: 'plc.pw' } } }),
      },
    );
    const result = validateProject(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => /Secret key "plc.pw" is referenced from more than one/.test(w)))
      .toBe(true);
  });

  it('does not warn when one file uses a key twice — that is not a collision', () => {
    const result = validateProject(connectProject({
      A: { Password: { $secretRef: 'plc.pw' } },
      B: { Password: { $secretRef: 'plc.pw' } },
    }));
    expect(result.warnings.some(w => /referenced from more than one/.test(w))).toBe(false);
  });

  it('checks an unreferenced connect file too — it still gets committed', () => {
    const result = validateProject(projectWith(
      { ...BASE, documents: [doc()] },
      { 'models/a.glb': 'x', 'connect/orphan.json': JSON.stringify({ ApiKey: 'plain-value' }) },
    ));
    expect(result.ok).toBe(false);
  });

  it('leaves the secrets sidecar itself alone — it is the one place a value belongs', () => {
    // …and it is caught by name (`isSecretFileName`) if it is ever committed,
    // which is what the failure below actually is.
    const result = validateProject(projectWith(
      { ...BASE, documents: [doc()] },
      { 'models/a.glb': 'x', 'connect/secrets.local.json': JSON.stringify({ 'plc.pw': 'hunter2' }) },
    ));
    expect(result.errors.some(e => /Possible secret committed/.test(e))).toBe(true);
    expect(result.errors.some(e => /plaintext secret/.test(e))).toBe(false);
  });
});

/**
 * plan-434 §2.6 — the project kind.
 *
 * Three severities, and each one is a decision rather than a style:
 * missing is a **warning** because this validator also runs over a customer
 * repository delivered before the field existed; an unknown value is an
 * **error** because a typo silently switches off every rule keyed on
 * `customer`; and a customer without vendor globs is an **error** because it
 * is a project we deliver to that no delivery can ever change.
 */
describe('project kind', () => {
  const withKind = (over: Record<string, unknown>) => project({ ...BASE, ...over });

  it('warns — never fails — when the field is not there yet', () => {
    const { vendor, ...noVendor } = BASE;
    const result = validateProject(project({ ...noVendor }));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some(w => /no "kind"/.test(w) && /migrate-project-manifest/.test(w))).toBe(true);
  });

  it('accepts each of the three kinds and says nothing about them', () => {
    for (const kind of ['customer', 'demo', 'internal']) {
      const result = validateProject(withKind({ kind }));
      expect(result.ok, `${kind} must validate`).toBe(true);
      expect(result.warnings.filter(w => /"kind"/.test(w))).toEqual([]);
    }
  });

  it('fails on a value outside the enum, including the retired "seed"', () => {
    for (const kind of ['seed', 'Customer', 'partner', '', 42, null]) {
      const result = validateProject(withKind({ kind }));
      expect(result.ok, `${JSON.stringify(kind)} must be refused`).toBe(false);
      expect(result.errors.some(e => /"kind" is/.test(e) && /customer, demo, internal/.test(e))).toBe(true);
    }
  });

  it('fails a customer project that has no vendor.managed globs to deliver through', () => {
    const { vendor, ...noVendor } = BASE;
    for (const broken of [{}, { vendor: {} }, { vendor: { managed: [] } }, { vendor: { handover: ['a/**'] } }]) {
      const result = validateProject(project({ ...noVendor, kind: 'customer', ...broken }));
      expect(result.ok).toBe(false);
      expect(result.errors.some(e => /no "vendor.managed"/.test(e))).toBe(true);
    }
    // The same manifest as a demo or a fixture is fine: nothing is delivered
    // into it, so "everything is customer-owned" is the right default.
    expect(validateProject(project({ ...noVendor, kind: 'internal' })).ok).toBe(true);
    expect(validateProject(project({ ...noVendor, kind: 'demo' })).ok).toBe(true);
  });
});

/**
 * plan-434 phase 2 — `local/` is a recognised project folder.
 *
 * `projects/wmyb/local` holds NDA material that is neither delivered nor
 * published. It is already zone C by construction (no vendor glob names it, and
 * unknown means customer-owned in `_vendor-merge.mjs`); the only thing missing
 * was that the validator called the spelling unrecognised.
 */
describe('known top-level folders', () => {
  it('does not flag local/ as unrecognised, but still flags a folder nobody knows', () => {
    const dir = project({ ...BASE, kind: 'customer' });
    mkdirSync(join(dir, 'local'), { recursive: true });
    mkdirSync(join(dir, 'whatever'), { recursive: true });
    const result = validateProject(dir);
    expect(result.warnings.some(w => /Unrecognised top-level folder "local"/.test(w))).toBe(false);
    expect(result.warnings.some(w => /Unrecognised top-level folder "whatever"/.test(w))).toBe(true);
  });
});
