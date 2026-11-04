// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-544 F1–F4, F10 — the shared third-party notices core
 * (scripts/lib/rv-third-party-notices.mjs): licence-field normalisation, SPDX evaluation,
 * policy application (exceptions, vendor terms, dynamic-only LGPL, stale entries per policy file
 * and tier), rendering and determinism. Plus the shrink-only exception ceilings of the policy
 * files and the public-safety rule (the mirrored policy names nothing from the private one).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  OCCT_NOTICE,
  applyPolicy,
  componentFromPackageDir,
  componentFromManual,
  evaluateSpdx,
  identifyLicenseText,
  loadPolicy,
  noticesWarnBanner,
  normalizeLicenseField,
  normalizeText,
  readNoticesMode,
  renderJson,
  renderNotices,
  resolveNoticesMode,
  RELEASE_DEFAULT_MODE,
  type LicensePolicy,
  type ThirdPartyComponent,
} from '../scripts/lib/rv-third-party-notices.mjs';

const ROOT = resolve(__dirname, '..');
const PUBLIC_POLICY = join(ROOT, 'third-party', 'license-policy.json');

/**
 * Frozen number of `exceptions` per policy file — only ever LOWERED. Raising one needs the
 * user's approval (plan-544 F3). `decidedBy: "proposed"` entries count too: they are proposals
 * waiting for that approval. The Private policy has its own ceiling and the public-safety check in
 * the private sibling repo (tests/third-party-policy.node.test.ts there; this file must stay free of
 * private paths — community parity).
 */
const EXCEPTION_CEILING = { public: 0 } as const;

const POLICY: LicensePolicy = {
  scope: 'public',
  path: 'public.json',
  allowed: ['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'MPL-2.0', 'OCCT-exception-1.0'],
  dynamicOnly: ['LGPL-2.1-only', 'LGPL-2.1-or-later'],
  exceptions: [],
  vendorTerms: [],
};

function component(over: Partial<ThirdPartyComponent> = {}): ThirdPartyComponent {
  return {
    name: 'pkg', version: '1.0.0', license: 'MIT', licenseExpression: 'MIT', copyright: ['Copyright (c) A'],
    licenseText: 'MIT text', source: 'https://example.invalid/pkg', origin: 'npm', linking: 'static', notes: [],
    ...over,
  };
}

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'rv-notices-core-')); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

function writePackage(name: string, files: Record<string, string>): string {
  const dir = join(work, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

describe('normalizeLicenseField — legacy npm forms (F1)', () => {
  it('reads a plain SPDX string and canonicalises the id', () => {
    expect(normalizeLicenseField({ license: 'mit' }).expression).toBe('MIT');
  });
  it('reads the legacy {type,url} object', () => {
    expect(normalizeLicenseField({ license: { type: 'BSD-3-Clause', url: 'x' } }).expression).toBe('BSD-3-Clause');
  });
  it('turns a licenses[] array into an OR expression', () => {
    expect(normalizeLicenseField({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] }).expression).toBe('MIT OR Apache-2.0');
  });
  it('maps SEE LICENSE IN <file> to LicenseRef-file with the file name', () => {
    expect(normalizeLicenseField({ license: 'SEE LICENSE IN LICENSE.txt' })).toMatchObject({ expression: 'LicenseRef-file', licenseFile: 'LICENSE.txt' });
  });
  it('keeps UNLICENSED as a non-allowed LicenseRef', () => {
    expect(normalizeLicenseField({ license: 'UNLICENSED' }).expression).toBe('LicenseRef-UNLICENSED');
  });
  it('maps free-text aliases ("Apache 2.0", "MIT/X11") and leaves unknown text unknown', () => {
    expect(normalizeLicenseField({ license: 'Apache 2.0' }).expression).toBe('Apache-2.0');
    expect(normalizeLicenseField({ license: 'MIT/X11' }).expression).toBe('MIT');
    expect(normalizeLicenseField({ license: 'Public Domain, see readme' }).expression).toBe('LicenseRef-unknown');
    // A bare unknown word stays as written and is simply not allowed.
    expect(evaluateSpdx(normalizeLicenseField({ license: 'Custom' }).expression, POLICY).ok).toBe(false);
  });
  it('maps deprecated ids to their successor', () => {
    expect(normalizeLicenseField({ license: 'LGPL-2.1' }).expression).toBe('LGPL-2.1-only');
  });
});

describe('evaluateSpdx (F1)', () => {
  it('allows a single allowed id', () => {
    expect(evaluateSpdx('MIT', POLICY)).toMatchObject({ ok: true, chosen: 'MIT' });
  });
  it('OR chooses the first allowed alternative in policy order: (GPL-3.0 OR MIT) → MIT', () => {
    expect(evaluateSpdx('(GPL-3.0-only OR MIT)', POLICY)).toMatchObject({ ok: true, chosen: 'MIT' });
    // Apache-2.0 ranks after MIT in `allowed`, so MIT wins regardless of the written order.
    expect(evaluateSpdx('Apache-2.0 OR MIT', POLICY).chosen).toBe('MIT');
  });
  it('AND requires every part: (MIT AND Apache-2.0) ok, (MIT AND GPL-3.0-only) not', () => {
    expect(evaluateSpdx('(MIT AND Apache-2.0)', POLICY).ok).toBe(true);
    expect(evaluateSpdx('MIT AND GPL-3.0-only', POLICY).ok).toBe(false);
  });
  it('WITH: LGPL-2.1-only WITH OCCT-exception-1.0 is allowed and dynamic-only', () => {
    expect(evaluateSpdx('LGPL-2.1-only WITH OCCT-exception-1.0', POLICY)).toMatchObject({ ok: true, dynamicOnly: true });
  });
  it('an unparseable expression is not ok', () => {
    expect(evaluateSpdx('MIT AND (', POLICY).ok).toBe(false);
  });
});

describe('applyPolicy (F3)', () => {
  it('reports unknown licences and missing licence texts', () => {
    const { violations } = applyPolicy([
      component({ name: 'nolicense', licenseExpression: '' }),
      component({ name: 'notext', licenseText: '' }),
    ], [POLICY]);
    expect(violations.map((v) => v.rule)).toEqual(['unknown-license', 'missing-license-text']);
  });

  it('LGPL bundled into a chunk or without linking:dynamic is a violation; dynamic passes', () => {
    const { violations } = applyPolicy([
      component({ name: 'lgpl-bundled', licenseExpression: 'LGPL-2.1-only', linking: 'static' }),
      component({ name: 'lgpl-undeclared', licenseExpression: 'LGPL-2.1-only', linking: undefined }),
      component({ name: 'lgpl-dynamic', licenseExpression: 'LGPL-2.1-only', linking: 'dynamic' }),
    ], [POLICY]);
    expect(violations.map((v) => `${v.name}:${v.rule}`)).toEqual(['lgpl-bundled:lgpl-not-dynamic', 'lgpl-undeclared:lgpl-not-dynamic']);
  });

  it('third-party GPL is a violation marked as strong copyleft', () => {
    const { violations } = applyPolicy([component({ name: 'gpl', licenseExpression: 'GPL-3.0-only' })], [POLICY]);
    expect(violations[0].message).toMatch(/strong copyleft/);
  });

  it('an exception covers a matching name/version/licence; a proposed one does not', () => {
    const policy = { ...POLICY, exceptions: [
      { name: 'odd', version: '1.0.0', license: 'LicenseRef-x', reason: 'r', decidedBy: 'thomas', date: '2026-10-03' },
      { name: 'pending', version: '1.0.0', license: 'LicenseRef-x', reason: 'r', decidedBy: 'proposed', date: '2026-10-03' },
    ] };
    const odd = component({ name: 'odd', licenseExpression: 'LicenseRef-x' });
    const { violations } = applyPolicy([odd, component({ name: 'pending', licenseExpression: 'LicenseRef-x' })], [policy]);
    expect(odd.exception?.decidedBy).toBe('thomas');
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ name: 'pending', rule: 'license-not-allowed' });
    expect(violations[0].message).toMatch(/proposed exception awaits a decision/);
  });

  it('stale exceptions are violations per policy file and tier: private only in the private tier, customer never', () => {
    const stale = { name: 'gone', version: '1.0.0', license: 'MIT', reason: 'r', decidedBy: 'thomas', date: 'd' };
    const pub = { ...POLICY, path: 'pub', exceptions: [stale] };
    const priv: LicensePolicy = { ...POLICY, path: 'priv', scope: 'private', allowed: [], dynamicOnly: [], exceptions: [{ ...stale, name: 'private-gone' }] };
    const cust: LicensePolicy = { ...POLICY, path: 'cust', scope: 'customer', allowed: [], dynamicOnly: [], exceptions: [{ ...stale, name: 'customer-gone' }] };
    const names = (tier: 'public' | 'demo' | 'private') => applyPolicy([component()], [pub, priv, cust], { tier }).violations
      .filter((v) => v.rule === 'stale-exception').map((v) => v.name);
    expect(names('public')).toEqual(['gone']);
    expect(names('demo')).toEqual(['gone']);
    expect(names('private')).toEqual(['gone', 'private-gone']);
  });

  it('an approval for a DECLARED component this build does not ship is not stale; an undeclared one is', () => {
    const entry = (name: string) => ({ name, version: '1.0.0', vendor: 'V', licenseRef: 'V terms', reason: 'r', decidedBy: 'thomas', date: 'd' });
    const pub = { ...POLICY, path: 'pub', vendorTerms: [entry('demo-only-content'), entry('gone')] };
    const stale = applyPolicy([component()], [pub], { declared: ['demo-only-content'] }).violations
      .filter((v) => v.rule === 'stale-exception').map((v) => v.name);
    expect(stale).toEqual(['gone']);
    // A shipped component is still matched by name AND version — `declared` silences nothing.
    const shipped = component({ name: 'demo-only-content', version: '2.0.0', licenseExpression: 'LicenseRef-x', vendorTerms: true });
    expect(applyPolicy([shipped], [pub], { declared: ['demo-only-content', 'gone'] }).violations.map((v) => v.rule)).toEqual(['vendor-terms']);
  });

  it('a vendorTerms entry moves a component into the vendor section; a proposed one leaves a violation', () => {
    const policy = { ...POLICY, vendorTerms: [
      { name: 'vend', version: '*', vendor: 'ACME', licenseRef: 'ACME EULA', reason: 'licensed', decidedBy: 'thomas' },
      { name: 'vend2', version: '*', vendor: 'ACME', licenseRef: 'ACME EULA', reason: 'licensed', decidedBy: 'proposed' },
    ] };
    const vend = component({ name: 'vend', licenseExpression: 'LicenseRef-file', licenseText: '' });
    const { violations } = applyPolicy([vend, component({ name: 'vend2', licenseExpression: 'LicenseRef-file', vendorTerms: true })], [policy]);
    expect(vend.vendorTerms).toBe(true);
    expect(violations.map((v) => `${v.name}:${v.rule}`)).toEqual(['vend2:vendor-terms']);
    const text = renderNotices({ product: 'P', components: [vend], mode: 'warn' });
    expect(text).toContain('Third-party components under vendor terms');
    expect(text).toContain('Vendor: ACME');
  });

  it('a pending manual entry stays red', () => {
    const { violations } = applyPolicy([component({ name: 'rust-bin', pending: 'crates not itemised' })], [POLICY]);
    expect(violations[0]).toMatchObject({ rule: 'pending-audit' });
  });
});

describe('component records (F2)', () => {
  it('reads a package without a license field but with a LICENSE file (canonical text identifies it)', () => {
    const mit = readFileSync(join(ROOT, 'third-party/license-texts/MIT.txt'), 'utf8');
    const dir = writePackage('see-file', {
      'package.json': JSON.stringify({ name: 'see-file', version: '2.0.0', license: 'SEE LICENSE IN LICENSE.md' }),
      'LICENSE.md': `MIT License\n\nCopyright (c) 2024 Someone\n\n${mit.split('\n').slice(2).join('\n')}`,
    });
    const c = componentFromPackageDir(dir);
    expect(c.licenseExpression).toBe('MIT');
    expect(c.copyright).toEqual(['Copyright (c) 2024 Someone']);
  });

  it('uses the canonical text plus the author when a package ships no licence file', () => {
    const dir = writePackage('bare', { 'package.json': JSON.stringify({ name: 'bare', version: '1.2.3', license: 'ISC', author: 'Jane Doe <jane@x.invalid>' }) });
    const c = componentFromPackageDir(dir);
    expect(c.licenseText).toContain('Permission to use, copy, modify');
    expect(c.copyright).toEqual(['Copyright (c) Jane Doe']);
    expect(c.source).toBe('https://www.npmjs.com/package/bare/v/1.2.3');
  });

  it('carries the Apache NOTICE file', () => {
    const dir = writePackage('apache', {
      'package.json': JSON.stringify({ name: 'apache', version: '1.0.0', license: 'Apache-2.0' }),
      'NOTICE': 'Apache Thing\nCopyright 2020 The Apache Software Foundation',
    });
    const c = componentFromPackageDir(dir);
    expect(c.noticeText).toContain('Apache Thing');
    expect(renderNotices({ product: 'P', components: [c], mode: 'warn' })).toContain('NOTICE:\nApache Thing');
  });

  it('identifies a licence file only on a complete canonical text', () => {
    const mit = readFileSync(join(ROOT, 'third-party/license-texts/MIT.txt'), 'utf8');
    expect(identifyLicenseText(mit)).toBe('MIT');
    expect(identifyLicenseText(mit.slice(0, 400))).toBeNull();
  });

  it('a manual entry cuts its text from a section of a shared file', () => {
    writeFileSync(join(work, 'inv.txt'), '====\n A lib (a.dll)\n====\nA licence text\n\n====\n B lib\n====\nB text\n');
    const c = componentFromManual({ name: 'A', version: '1', license: 'MIT', licenseFile: 'inv.txt', licenseSection: { start: 'A lib', end: 'B lib' } }, { baseDir: work });
    expect(c.licenseText).toBe(' A lib (a.dll)\n====\nA licence text');
  });
});

describe('rendering (F1, F4, F10)', () => {
  it('MPL and LGPL notes; OCCT notice is the first paragraph; warn violations sit at the top', () => {
    const components = [
      component({ name: 'mediabunny', version: '1.61.0', licenseExpression: 'MPL-2.0', source: 'https://www.npmjs.com/package/mediabunny/v/1.61.0' }),
      component({ name: 'occt', licenseExpression: 'LGPL-2.1-only WITH OCCT-exception-1.0', linking: 'dynamic' }),
    ];
    const { violations } = applyPolicy(components, [POLICY]);
    const text = renderNotices({ product: 'P', components, violations: [...violations, { name: 'x', version: '1', rule: 'r', message: 'boom' }], mode: 'warn' });
    expect(text.split('\n')[0]).toBe(OCCT_NOTICE);
    expect(text).toContain('Source code of this component: https://www.npmjs.com/package/mediabunny/v/1.61.0; used unmodified.');
    expect(text).toContain('you may replace it with a modified, interface-compatible version');
    expect(text.indexOf('Policy violations (warn mode)')).toBeLessThan(text.indexOf('Components ('));
  });

  it('dedupes identical licence texts, keeps per-package copyright and lists two versions of one package', () => {
    const text = renderNotices({ product: 'P', mode: 'warn', components: [
      component({ name: 'a', copyright: ['Copyright A'] }),
      component({ name: 'b', copyright: ['Copyright B'] }),
      component({ name: 'b', version: '2.0.0', copyright: ['Copyright B2'] }),
    ] });
    expect(text.match(/^\[L\d+\]/gm)).toEqual(['[L1]']);
    expect(text).toContain('Applies to: a 1.0.0, b 1.0.0, b 2.0.0');
    for (const line of ['Copyright A', 'Copyright B', 'Copyright B2']) expect(text).toContain(line);
  });

  it('is byte-identical across runs and independent of CRLF/BOM in the inputs', () => {
    const lf = writePackage('lf', { 'package.json': JSON.stringify({ name: 'lf', version: '1.0.0', license: 'MIT' }), 'LICENSE': 'Copyright (c) X\n\nSome text\n' });
    const crlfDir = join(work, 'crlf');
    mkdirSync(crlfDir, { recursive: true });
    writeFileSync(join(crlfDir, 'package.json'), '﻿' + JSON.stringify({ name: 'lf', version: '1.0.0', license: 'MIT' }));
    writeFileSync(join(crlfDir, 'LICENSE'), '﻿Copyright (c) X  \r\n\r\nSome text\r\n');
    const render = (dir: string) => {
      const components = [componentFromPackageDir(dir)];
      const { violations } = applyPolicy(components, [POLICY]);
      return renderNotices({ product: 'P', components, violations, mode: 'enforce' }) + renderJson({ product: 'P', components, violations, mode: 'enforce' });
    };
    const first = render(lf);
    expect(render(lf)).toBe(first);
    expect(render(crlfDir)).toBe(first);
    expect(first).not.toMatch(/\r|﻿/);
  });

  it('normalizeText strips BOM, CRLF and trailing whitespace', () => {
    expect(normalizeText('﻿a  \r\nb\t\r\n\r\n')).toBe('a\nb');
  });
});

describe('mode resolution and banners (F11)', () => {
  it('RV_NOTICES_MODE wins; release builds use the release default; local builds warn', () => {
    expect(resolveNoticesMode({ env: { RV_NOTICES_MODE: 'enforce' } }).mode).toBe('enforce');
    expect(resolveNoticesMode({ env: { RV_NOTICES_MODE: 'warn' }, releaseBuild: true, releaseDefault: 'enforce' }).mode).toBe('warn');
    expect(resolveNoticesMode({ env: {}, releaseBuild: true }).mode).toBe(RELEASE_DEFAULT_MODE);
    expect(resolveNoticesMode({ env: {}, releaseBuild: false }).mode).toBe('warn');
    expect(resolveNoticesMode({ env: { RV_NOTICES_MODE: 'off' } }).mode).toBe('warn');
  });

  it('since plan-544 Phase 6 the release default is enforce', () => {
    expect(RELEASE_DEFAULT_MODE).toBe('enforce');
  });

  it('the banner fires for warn and for missing notices, not for enforce', () => {
    const warnJson = join(work, 'warn.json');
    writeFileSync(warnJson, JSON.stringify({ mode: 'warn', violations: [{}] }));
    const enforceJson = join(work, 'enforce.json');
    writeFileSync(enforceJson, JSON.stringify({ mode: 'enforce', violations: [] }));
    expect(noticesWarnBanner(warnJson)).toMatch(/WARN mode[\s\S]*violations: 1/);
    expect(noticesWarnBanner(join(work, 'missing.json'))).toMatch(/MISSING/);
    expect(noticesWarnBanner(enforceJson)).toBeNull();
    expect(readNoticesMode(warnJson)).toBe('warn');
  });
});

describe('public policy file — ceiling (F3)', () => {
  const pub = loadPolicy(PUBLIC_POLICY, { scope: 'public' })!;

  it('the public policy holds the plan allowlist and the dynamic-only LGPL ids', () => {
    // CC-BY-4.0: Thomas 2026-10-03 (Monaco codicon font; attribution carried in the notices).
    expect(pub.allowed).toEqual(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Zlib', 'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0', 'MPL-2.0', 'OFL-1.1', 'CC-BY-4.0', 'OCCT-exception-1.0']);
    expect(pub.dynamicOnly).toEqual(['LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later']);
  });

  it('exception count never grows', () => {
    expect(pub.exceptions.length, 'raising EXCEPTION_CEILING needs the approval of the user').toBeLessThanOrEqual(EXCEPTION_CEILING.public);
    expect(pub.exceptions.length, `lower EXCEPTION_CEILING.public to ${pub.exceptions.length}`).toBe(EXCEPTION_CEILING.public);
  });

  it('every exception and vendor entry carries a reason and a decision field', () => {
    for (const entry of [...pub.exceptions, ...pub.vendorTerms]) {
      expect(entry.reason, `${entry.name} needs a reason`).toBeTruthy();
      expect((entry as { decidedBy?: string }).decidedBy, `${entry.name} needs decidedBy`).toBeTruthy();
    }
  });

  it('every allowlisted licence has a canonical text', () => {
    for (const id of pub.allowed) {
      expect(readFileSync(join(ROOT, 'third-party', 'license-texts', `${id}.txt`), 'utf8').length, id).toBeGreaterThan(200);
    }
  });
});

describe('occt-import-js manual entry (loose files, Thomas 2026-10-03)', () => {
  const manual = JSON.parse(readFileSync(join(ROOT, 'third-party', 'manual-components.json'), 'utf8')).components as Array<Record<string, unknown>>;
  const entry = manual.find((c) => c.name === 'occt-import-js')!;

  it('matches the installed npm version, is dynamic and declares the memory limit patch', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(entry, 'occt-import-js entry missing').toBeTruthy();
    expect(entry.version).toBe(pkg.dependencies['occt-import-js']);
    expect(entry.source).toBe(`https://www.npmjs.com/package/occt-import-js/v/${entry.version}`);
    expect(entry.linking).toBe('dynamic');
    expect(entry.modified).toBe('memory limit patch');
    expect(entry.match).toEqual(['occt/occt-import-js.js', 'occt/occt-import-js.wasm']);
  });

  it('renders as a modified, replaceable LGPL library without a violation', () => {
    const c = componentFromManual(entry as never, { baseDir: join(ROOT, 'third-party') });
    const { violations } = applyPolicy([c], [{ ...POLICY, dynamicOnly: ['LGPL-2.1-only'] }]);
    expect(violations).toEqual([]);
    const text = renderNotices({ product: 'P', components: [c], mode: 'warn' });
    expect(text).toContain(`- occt-import-js ${entry.version} — modified (memory limit patch) — LGPL-2.1-only`);
    expect(text).toContain('you may replace it with a modified, interface-compatible version');
    expect(text).toContain('occt/occt-import-js.wasm');
    expect(text).toContain('GNU LESSER GENERAL PUBLIC LICENSE');
    expect(JSON.parse(renderJson({ product: 'P', components: [c], mode: 'warn' })).components[0].modified).toBe('memory limit patch');
  });
});
