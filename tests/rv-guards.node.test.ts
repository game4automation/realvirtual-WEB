// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * _rv-guards — the consolidated delivery/publish guards (plan-700 Phase 2).
 *
 * Two things are tested here, and the second matters more than the first:
 *
 *  1. that the rules are right, and
 *  2. that they are the ONLY copy.
 *
 * The consolidation is worth nothing if a caller regrows its own secret list a
 * year from now — that is exactly how the four drifting copies came about, and
 * how `connect/secrets.local.json` ended up in none of them. The drift test at
 * the bottom greps the four call sites and fails on a local pattern array.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  isSecretFileName,
  isSecretPath,
  isDeniedProjectArtifactPath,
  isDeniedProjectArtifact,
  isProjectAssetSkipDir,
  knownProjectKeys,
  assertNoSecrets,
  secretContentViolation,
  vendorGlobProblems,
  CUSTOMER_OWNED_FOLDERS,
  DEFAULT_VENDOR_BLOCK,
} from '../scripts/_rv-guards.mjs';

const SCRIPTS = resolve(__dirname, '../scripts');

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rv-guards-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('secret file names', () => {
  it('recognises the CONNECT secrets file that no previous list carried (B11)', () => {
    expect(isSecretFileName('secrets.local.json')).toBe(true);
    expect(isSecretPath('connect/secrets.local.json')).toBe(true);
    expect(isSecretFileName('gateway.secrets.json')).toBe(true);
  });

  it('recognises the classic secret shapes', () => {
    for (const name of [
      '.env', '.env.local', '.env.production', '.npmrc', '.mcp_auth_token',
      'server.pem', 'cert.p12', 'cert.pfx', 'key.snk', 'id_rsa', 'id_ed25519',
      'release.keystore', 'credentials.json', 'service-account-prod.json',
    ]) {
      expect(isSecretFileName(name), name).toBe(true);
    }
  });

  it('does not flag ordinary project content', () => {
    for (const name of [
      'project.json', 'settings.json', 'model.glb', 'README.md',
      'environment.ts', 'credentials-guide.md', 'p12-adapter.ts',
    ]) {
      expect(isSecretFileName(name), name).toBe(false);
    }
  });

  it('matches a secret in any path segment, not only the last one', () => {
    expect(isSecretPath('a/b/.env.local')).toBe(true);
    expect(isSecretPath('.env.d/config')).toBe(true);
    expect(isSecretPath('models/machine.glb')).toBe(false);
  });
});

describe('denied project artefacts', () => {
  it('denies derived RAG data at any depth', () => {
    for (const rel of [
      'index/state.bin', 'runtime/foo.bin', 'assets/RUNTIME/x.bin',
      'vector-index.json', 'docs/VECTOR-INDEX.json', 'a/b.summary.json', 'secret.key',
    ]) {
      expect(isDeniedProjectArtifactPath(rel), rel).toBe(true);
    }
  });

  it('denies configuration files that can carry credentials', () => {
    for (const rel of ['project.json', 'project-config.json', 'llm.json', 'comments.json']) {
      expect(isDeniedProjectArtifactPath(rel), rel).toBe(true);
    }
  });

  it('keeps real assets, including a nested folder whose name is a top-level skip name', () => {
    for (const rel of ['docs/manual.pdf', 'assets/branding/logo.png', 'docs/scripts/how-to.md']) {
      expect(isDeniedProjectArtifactPath(rel), rel).toBe(false);
    }
  });

  it('separates the shallow skip list from the recursive artefact rule', () => {
    expect(isProjectAssetSkipDir('models')).toBe(true);
    expect(isProjectAssetSkipDir('scripts')).toBe(true);
    expect(isProjectAssetSkipDir('docs')).toBe(false);
    // The same name one level down is content, not machinery:
    expect(isDeniedProjectArtifactPath('docs/scripts/x.md')).toBe(false);
  });

  it('treats a path outside the project root as none of its business', () => {
    expect(isDeniedProjectArtifact('/a/project', '/a/other/index/x.bin')).toBe(false);
    expect(isDeniedProjectArtifact('/a/project', '/a/project/index/x.bin')).toBe(true);
  });
});

describe('knownProjectKeys', () => {
  it('returns exactly the folders under projects/ that carry a manifest', () => {
    for (const name of ['alpha', 'beta', 'gamma']) {
      mkdirSync(join(root, 'projects', name), { recursive: true });
      writeFileSync(join(root, 'projects', name, 'project.json'), '{}');
    }
    mkdirSync(join(root, 'projects', 'scratch'), { recursive: true });
    mkdirSync(join(root, 'projects', '.hidden'), { recursive: true });
    expect(knownProjectKeys(root)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('returns an empty list rather than throwing when there is no projects/ folder', () => {
    expect(knownProjectKeys(root)).toEqual([]);
  });
});

describe('assertNoSecrets', () => {
  it('throws on a secret file and names it', () => {
    mkdirSync(join(root, 'connect'), { recursive: true });
    writeFileSync(join(root, 'connect', 'secrets.local.json'), '{"ApiKey":"x"}');
    expect(() => assertNoSecrets(root)).toThrow(/secrets\.local\.json/);
  });

  it('passes a clean tree', () => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'manual.md'), '# Manual\n');
    writeFileSync(join(root, 'project.json'), '{"name":"p"}');
    expect(() => assertNoSecrets(root)).not.toThrow();
  });
});

describe('secretContentViolation', () => {
  it('flags a PEM block and a token-shaped literal', () => {
    expect(secretContentViolation('a.ts', '.ts', '-----BEGIN PRIVATE KEY-----')).toMatch(/PEM/);
    expect(secretContentViolation('a.ts', '.ts', 'const k = "ghp_abcdefghijklmnopqrstuvwxyz01";')).toMatch(/Token-like/);
  });

  it('leaves an ordinary source file alone', () => {
    expect(secretContentViolation('a.ts', '.ts', 'export const speed = 100; // mm/s')).toBeNull();
  });
});

describe('vendor globs', () => {
  it('accepts the conservative default', () => {
    expect(vendorGlobProblems({
      managed: [...DEFAULT_VENDOR_BLOCK.managed],
      handover: [...DEFAULT_VENDOR_BLOCK.handover],
    })).toEqual([]);
  });

  it('accepts an absent vendor block (the safe default is "all customer-owned")', () => {
    expect(vendorGlobProblems(undefined)).toEqual([]);
    expect(vendorGlobProblems(null)).toEqual([]);
  });

  it('refuses a glob that claims the whole project', () => {
    for (const glob of ['**', '*', '**/*']) {
      expect(vendorGlobProblems({ managed: [glob] }), glob).toHaveLength(1);
    }
  });

  it('refuses any glob that can reach a customer-owned folder', () => {
    for (const folder of CUSTOMER_OWNED_FOLDERS) {
      expect(vendorGlobProblems({ managed: [folder + '/**'] }), folder).toHaveLength(1);
    }
    // The non-obvious one: a wildcard first segment reaches scenes/ too.
    expect(vendorGlobProblems({ managed: ['*/*.json'] })).toHaveLength(1);
  });

  it('reports a handover glob that no managed glob covers', () => {
    expect(vendorGlobProblems({ managed: ['models/**'], handover: ['docs/x.md'] })).toHaveLength(1);
    expect(vendorGlobProblems({ managed: ['models/**'], handover: ['models/custom/**'] })).toEqual([]);
  });

  it('refuses a glob that escapes the project', () => {
    expect(vendorGlobProblems({ managed: ['../other/**'] }).length).toBeGreaterThan(0);
    expect(vendorGlobProblems({ managed: ['/etc/passwd'] }).length).toBeGreaterThan(0);
  });

  it('refuses a vendor block of the wrong shape', () => {
    expect(vendorGlobProblems({ managed: 'models/**' })).toHaveLength(1);
    expect(vendorGlobProblems([])).toHaveLength(1);
  });
});

/**
 * The point of the whole module: one list, not five.
 *
 * Greps the four historical call sites for a locally defined pattern array. A
 * new copy is the exact regression this plan exists to prevent, and it is
 * invisible in review because each copy looks reasonable on its own.
 */
describe('no guard drift', () => {
  const CALLERS = [
    join(SCRIPTS, '_workspace-lib.mjs'),
    join(SCRIPTS, 'validate-project.mjs'),
    join(SCRIPTS, 'bunny-deploy.mjs'),
    resolve(SCRIPTS, '../../realvirtual-Connect~/tools/stage-project.mjs'),
  ];

  it.each(CALLERS)('%s defines no secret/deny list of its own', (file) => {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      // The CONNECT repo is a sibling checkout and may be absent; a missing
      // caller cannot drift.
      return;
    }
    // Strip comments before matching: the call sites carry prose that names
    // these very files, and a comment explaining the rule must not trip it.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(line => !/^\s*(\/\/|\*|#)/.test(line)).join('\n');

    for (const forbidden of [
      /const\s+SECRET_FILES\s*=/,
      /const\s+SECRET_FILE_PATTERNS\s*=/,
      /const\s+SECRET_SCAN_EXTENSIONS\s*=/,
      /const\s+KNOWN_SECRET_FORMAT\s*=/,
      /const\s+skipDirs\s*=\s*new\s+Set/,
      /knownProjectKeys\s*:\s*\[/,
    ]) {
      expect(code, `${file} must not redefine ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('the generator reads the project keys from disk instead of hardcoding them (B4)', () => {
    const source = readFileSync(join(SCRIPTS, 'generate-customer-workspace.mjs'), 'utf8');
    expect(source).toMatch(/knownProjectKeys\(privateRoot\)/);
    expect(source).not.toMatch(/'mauser3dhmi',\s*'Toray'/);
  });
});
