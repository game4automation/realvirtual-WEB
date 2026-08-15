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
  containsHighEntropyFragment,
  vendorGlobProblems,
  isAllowedSecretSchemaPath,
  isCredentialPropertyName,
  isSecretReferenceValue,
  plaintextSecretPaths,
  collectSecretRefKeys,
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

  /**
   * plan-434 §2.6. The filter exists for one caller — the foreign-customer-name
   * guard — and the property it needs is that a folder only counts as a customer
   * name when it SAYS so. Anything else (no kind, a typo, an unreadable file)
   * must fall out of the customer list rather than into it.
   */
  describe('kind filter', () => {
    const write = (name: string, manifest: string) => {
      mkdirSync(join(root, 'projects', name), { recursive: true });
      writeFileSync(join(root, 'projects', name, 'project.json'), manifest);
    };

    it('narrows to the folders declaring that kind, and leaves the unfiltered call alone', () => {
      write('acme', '{"kind":"customer"}');
      write('showroom', '{"kind":"demo"}');
      write('scratch', '{"kind":"internal"}');

      expect(knownProjectKeys(root, { kind: 'customer' })).toEqual(['acme']);
      expect(knownProjectKeys(root, { kind: 'demo' })).toEqual(['showroom']);
      expect(knownProjectKeys(root)).toEqual(['acme', 'scratch', 'showroom']);
    });

    it('never counts an unmigrated, mistyped or unreadable manifest as a customer', () => {
      write('legacy', '{}');                       // pre-migration: no kind at all
      write('typo', '{"kind":"Customer"}');        // outside the enum
      write('retired', '{"kind":"seed"}');         // the kind plan-434 removed
      write('broken', '{ not json');

      expect(knownProjectKeys(root, { kind: 'customer' })).toEqual([]);
      expect(knownProjectKeys(root)).toEqual(['broken', 'legacy', 'retired', 'typo']);
    });
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

  /**
   * The identifier band, both edges of it.
   *
   * These two names aborted every customer delivery: their CamelCase middle runs 25-26 characters,
   * over the old 24-character segment cap, so the separated-identifier exemption never applied and
   * a contract-test name read as a leaked token. The cap moved to 30 — still under the 33 that the
   * calibration comment claims for real token formats, which the second half asserts.
   */
  it('excuses long compound engineering identifiers', () => {
    for (const name of ['myShares_DeleteRemovesAndReturns410', 'upload_CrossOwnerConfirmOrDelete_403']) {
      expect(containsHighEntropyFragment(name), name).toBe(false);
      expect(secretContentViolation('a.tsx', '.tsx', `// see \`${name}\``), name).toBeNull();
    }
  });

  it('still catches a real token behind an identifier-shaped prefix', () => {
    // One dense run and no separator inside it — the shape the raised cap must not excuse.
    // Assembled at runtime so the literal never looks like a live Stripe key to
    // GitHub push protection (it blocked the mirror snapshot on this fixture).
    expect(containsHighEntropyFragment(['sk', 'live', '9dK2mQ7pXbR4tYw1LzA6vNc8HjE3sFgU'].join('_'))).toBe(true);
    expect(containsHighEntropyFragment('aws_secret_wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY')).toBe(true);
  });

  /**
   * The boundary itself, stated rather than implied — this is what raising the cap cost.
   *
   * A random run behind a separator prefix is detected from 30 characters up and excused below.
   * The previous edge was 24, so what opened is the 24..29 band. Every token format named in the
   * calibration comment keeps a run of 33+, which is why the band is believed to hold false
   * positives only; if a real format ever lands in it, this test is the place that has to change.
   */
  it('detects a random run from 30 characters and excuses shorter ones', () => {
    const random = 'A7bK9mQ2xR4tY6wL1zN8vC3hJ5sF0pT1uV2';
    expect(containsHighEntropyFragment(`prefix_${random.slice(0, 30)}`)).toBe(true);
    expect(containsHighEntropyFragment(`prefix_${random.slice(0, 29)}`)).toBe(false);
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
    // Narrowed to customer projects in plan-434 §2.6 — still read from disk.
    expect(source).toMatch(/knownProjectKeys\(privateRoot, \{ kind: 'customer' \}\)/);
    expect(source).not.toMatch(/'mauser3dhmi',\s*'Toray'/);
  });
});

/**
 * plan-718 §2.6 / §9.4 — secrets as REFERENCES.
 *
 * The allowlist gains one entry and the module gains one concept; both live
 * here, in the single home, so `validate-project.mjs` can keep having no list of
 * its own (the drift test above is what enforces that).
 */
describe('secret references (plan-718)', () => {
  it('allows a $secretRef leaf in a connect config, and nothing beside it', () => {
    expect(isAllowedSecretSchemaPath(
      'connect/linie-1.connect.json',
      ['Interfaces', 0, 'Settings', 'Password', '$secretRef'],
    )).toBe(true);
    // The value the reference replaces is still scanned.
    expect(isAllowedSecretSchemaPath(
      'connect/linie-1.connect.json',
      ['Interfaces', 0, 'Settings', 'Password'],
    )).toBe(false);
    // And the allowance does not leak out of connect/.
    expect(isAllowedSecretSchemaPath('settings/x.json', ['A', '$secretRef'])).toBe(false);
  });

  it('keeps the three pre-718 allowances exactly as they were', () => {
    expect(isAllowedSecretSchemaPath('connect/project-config.json', ['Diagnosis', 'RequestyApiKey'])).toBe(true);
    expect(isAllowedSecretSchemaPath('connect/project-config.json', ['Agents', 'DeliveredApiKeys', 'acme'])).toBe(true);
    expect(isAllowedSecretSchemaPath('realvirtual-web/public/settings.json', ['connectLicensePrefill'])).toBe(true);
    expect(isAllowedSecretSchemaPath('connect/project-config.json', ['Diagnosis', 'Something'])).toBe(false);
  });

  it('knows a credential-named property from an innocent one', () => {
    for (const name of ['Password', 'password', 'ApiKey', 'clientSecret', 'AccessKey', 'Passphrase']) {
      expect(isCredentialPropertyName(name), name).toBe(true);
    }
    for (const name of ['KeyFile', 'Keyword', 'Monkey', 'Name', 'Host', 'Port']) {
      expect(isCredentialPropertyName(name), name).toBe(false);
    }
  });

  it('accepts only the two reference forms as "not a value"', () => {
    expect(isSecretReferenceValue({ $secretRef: 'plc.pw' })).toBe(true);
    expect(isSecretReferenceValue('${env:RV_PLC_PW}')).toBe(true);
    expect(isSecretReferenceValue('')).toBe(true);
    expect(isSecretReferenceValue(null)).toBe(true);
    expect(isSecretReferenceValue('hunter2')).toBe(false);
    expect(isSecretReferenceValue({ $secretRef: '' })).toBe(false);
    expect(isSecretReferenceValue({ ref: 'plc.pw' })).toBe(false);
    // Not a substitution, just a string that starts like one.
    expect(isSecretReferenceValue('${env:A} and more')).toBe(false);
  });

  it('finds a plaintext secret wherever it is nested, and only there', () => {
    expect(plaintextSecretPaths({
      Interfaces: [
        { Settings: { Password: 'hunter2', Host: '10.0.0.1' } },
        { Settings: { Password: { $secretRef: 'plc.pw' } } },
      ],
      KeyFile: 'certs/plc.pem',
    })).toEqual(['Interfaces.0.Settings.Password']);
    expect(plaintextSecretPaths({})).toEqual([]);
  });

  it('collects every $secretRef key, for the collision warning', () => {
    expect(collectSecretRefKeys({
      A: { Password: { $secretRef: 'plc.pw' } },
      B: [{ Token: { $secretRef: 'mqtt.token' } }],
      C: { $secretRef: '   ' },
    }).sort()).toEqual(['mqtt.token', 'plc.pw']);
  });
});
