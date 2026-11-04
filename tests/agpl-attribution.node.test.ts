// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-679 Phase 9 (D10, D11, D14) — the AGPL notice per build stage.
 *
 * Rule: the watermark, the noscript source link and the JSON-LD licence appear exactly in a pure
 * AGPL/community build (no private tree). The demo (ADR-047), commercial customer workspaces (dev
 * server AND build) and hosted customer deploys carry none of them — removed from the HTML, not
 * hidden. The switch is the build stage, never `RV_COMMERCIAL`.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { agplAttributionEnabled, agplAttributionPlugin, demoNoticeEnabled, stripAgplAttribution, stripDemoNotice } from '../scripts/lib/rv-agpl-attribution.mjs';

const ROOT = resolve(__dirname, '..');
const INDEX_HTML = readFileSync(resolve(ROOT, 'index.html'), 'utf8');

function jsonLd(html: string): Record<string, unknown> {
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('no JSON-LD block');
  return JSON.parse(match[1]);
}

describe('the derivation from the build stage', () => {
  it('no private tree (GitHub mirror, VITE_PUBLIC_BUILD) -> notice; any private tree -> none', () => {
    expect(agplAttributionEnabled({ hasPrivate: false })).toBe(true);
    // Demo profile, commercial workspace, hosted deploy, dev checkout: all compile the private tree.
    expect(agplAttributionEnabled({ hasPrivate: true })).toBe(false);
  });

  it('RV_COMMERCIAL plays no part (the function does not even see the environment)', () => {
    const previous = process.env.RV_COMMERCIAL;
    try {
      for (const value of ['1', undefined]) {
        if (value === undefined) delete process.env.RV_COMMERCIAL; else process.env.RV_COMMERCIAL = value;
        expect(agplAttributionEnabled({ hasPrivate: true })).toBe(false);
        expect(agplAttributionEnabled({ hasPrivate: false })).toBe(true);
      }
    } finally {
      if (previous === undefined) delete process.env.RV_COMMERCIAL; else process.env.RV_COMMERCIAL = previous;
    }
  });

  it('vite.config.ts wires it from HAS_PRIVATE, for serve and build, as a define too', () => {
    const config = readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toMatch(/const AGPL_ATTRIBUTION = agplAttributionEnabled\(\{ hasPrivate: HAS_PRIVATE \}\);/);
    expect(config).toContain('agplAttributionPlugin(AGPL_ATTRIBUTION, { demoNotice: demoNoticeFor(command) })');
    expect(config).toContain('__RV_AGPL_ATTRIBUTION__: JSON.stringify(AGPL_ATTRIBUTION)');
    // The runtime hide is gone: a build that must not show it does not contain it.
    const main = readFileSync(resolve(ROOT, 'src', 'main.ts'), 'utf8');
    expect(main).not.toMatch(/getElementById\('rv-watermark'\);\s*\n\s*if \(wm\) wm\.style\.display/);
  });
});

describe('the HTML transform on the real index.html', () => {
  it('community build (true): the watermark with "AGPL-3.0" stays, untouched', () => {
    const plugin = agplAttributionPlugin(true);
    const html = plugin.transformIndexHtml(INDEX_HTML);
    expect(html).toBe(stripDemoNotice(INDEX_HTML));
    expect(html).toMatch(/<a id="rv-watermark"[\s\S]*?AGPL-3\.0[\s\S]*?<\/a>/);
    expect(jsonLd(html).license).toBe('https://www.gnu.org/licenses/agpl-3.0.html');
  });

  it('commercial / demo build (false): no watermark, no noscript source link, no JSON-LD licence', () => {
    const html = agplAttributionPlugin(false).transformIndexHtml(INDEX_HTML);
    expect(html).not.toContain('rv-watermark');
    expect(html).not.toContain('Source on GitHub (AGPL-3.0)');
    expect(html).not.toContain('AGPL Watermark');
    const ld = jsonLd(html);
    expect(ld.license).toBeUndefined();
    // Everything else of the page survives.
    expect(ld.name).toBe('realvirtual WEB');
    expect(html).toContain('<div id="react-root"></div>');
    expect(html).toContain('>Documentation</a>');
    expect(html).toContain('id="loading-overlay"');
    // Idempotent.
    expect(stripAgplAttribution(html)).toBe(html);
  });

  it('the dev server gets the same HTML: the plugin has no apply restriction', () => {
    // A delivered commercial workspace usually runs as `vite` dev server (start.ps1 / CONNECT).
    const plugin = agplAttributionPlugin(agplAttributionEnabled({ hasPrivate: true }));
    expect(plugin.apply).toBeUndefined();
    expect(plugin.transformIndexHtml(INDEX_HTML)).not.toContain('rv-watermark');
  });

  it('the demo profile (D14, ADR-047) carries no watermark', () => {
    // The demo build compiles the private tree (runBuild mode "demo" keeps it), so it is a
    // hasPrivate build like every commercial one.
    expect(agplAttributionPlugin(agplAttributionEnabled({ hasPrivate: true })).transformIndexHtml(INDEX_HTML)).not.toContain('rv-watermark');
  });

  it('the third-party notices stay in every build (D12): nothing of plan-544 is removed', () => {
    const settingsSource = readFileSync(resolve(ROOT, 'scripts', 'vite-plugin-third-party-notices.mjs'), 'utf8');
    // The notices are emitted by their own plugin into every build, independent of this transform.
    expect(settingsSource).toContain('NOTICES_TXT');
    const html = stripAgplAttribution(INDEX_HTML);
    for (const marker of ['THIRD-PARTY', 'third-party-notices']) {
      expect(html.includes(marker)).toBe(INDEX_HTML.includes(marker));
    }
  });
});

describe('the public-demo notice (#rv-demo-notice)', () => {
  const notice = /<a id="rv-demo-notice" href="https:\/\/realvirtual\.io\/en\/editions\/"[^>]*>\s*Evaluation demo · Non-commercial use only\s*<\/a>/;

  it('needs the private tree AND the explicit flag', () => {
    expect(demoNoticeEnabled({ hasPrivate: true, demoFlag: true })).toBe(true);
    expect(demoNoticeEnabled({ hasPrivate: true, demoFlag: false })).toBe(false);
    expect(demoNoticeEnabled({ hasPrivate: false, demoFlag: true })).toBe(false);
    expect(demoNoticeEnabled({ hasPrivate: false, demoFlag: false })).toBe(false);
  });

  it('demo build (private tree + flag): notice present, AGPL watermark gone', () => {
    const html = agplAttributionPlugin(agplAttributionEnabled({ hasPrivate: true }), { demoNotice: true }).transformIndexHtml(INDEX_HTML);
    expect(html).toMatch(notice);
    expect(html).toContain('#rv-demo-notice');
    expect(html).not.toContain('rv-watermark');
    expect(html).not.toContain('Source on GitHub (AGPL-3.0)');
    expect(jsonLd(html).license).toBeUndefined();
  });

  it('customer workspace / hosted deploy / dev checkout (private tree, no flag): neither notice', () => {
    const html = agplAttributionPlugin(agplAttributionEnabled({ hasPrivate: true })).transformIndexHtml(INDEX_HTML);
    expect(html).not.toContain('rv-watermark');
    expect(html).not.toContain('rv-demo-notice');
    expect(html).not.toContain('Non-commercial use only');
    expect(html).toContain('<div id="react-root"></div>');
    expect(html).toContain('id="loading-overlay"');
    expect(stripDemoNotice(html)).toBe(html);
  });

  it('pure AGPL build: watermark stays, demo notice gone - even if the flag leaks in', () => {
    for (const demoNotice of [false, true]) {
      const flag = demoNoticeEnabled({ hasPrivate: false, demoFlag: demoNotice });
      const html = agplAttributionPlugin(agplAttributionEnabled({ hasPrivate: false }), { demoNotice: flag }).transformIndexHtml(INDEX_HTML);
      expect(html).toMatch(/<a id="rv-watermark"[\s\S]*?AGPL-3\.0[\s\S]*?<\/a>/);
      expect(html).not.toContain('rv-demo-notice');
      expect(html).toBe(stripDemoNotice(INDEX_HTML));
    }
  });

  it('removing it leaves the rest of index.html byte-identical to the pre-notice page', () => {
    const stripped = stripDemoNotice(INDEX_HTML);
    expect(stripped).not.toContain('rv-demo-notice');
    expect(stripped).not.toContain('Demo notice');
    expect(stripped).toContain('<a id="rv-watermark"');
    expect(stripDemoNotice(stripped)).toBe(stripped);
  });

  it('vite.config.ts wires it from HAS_PRIVATE and RV_DEMO_NOTICE; only demo mode sets the flag', () => {
    const config = readFileSync(resolve(ROOT, 'vite.config.ts'), 'utf8');
    expect(config).toContain("process.env.RV_DEMO_NOTICE === '1' && command === 'build' && !process.env.VITE_PRIVATE_BUILD");
    expect(config).toContain('agplAttributionPlugin(AGPL_ATTRIBUTION, { demoNotice: demoNoticeFor(command) })');
    // An inherited flag cannot reach a customer project publish either.
    const publish = readFileSync(resolve(ROOT, 'scripts', 'publish-project.mjs'), 'utf8');
    expect(publish).toContain("RV_DEMO_NOTICE: '0'");
    const bunny = readFileSync(resolve(ROOT, 'scripts', '_bunny-lib.mjs'), 'utf8');
    const ws = readFileSync(resolve(ROOT, 'scripts', '_workspace-lib.mjs'), 'utf8');
    expect(bunny).toContain("env.RV_DEMO_NOTICE = mode === 'demo' && opts.demoWelcome === true ? '1' : '0';");
    expect(ws).toContain("env.RV_DEMO_NOTICE = options.mode === 'demo' && options.demoWelcome === true ? '1' : '0';");
  });

  it('the notice is not underlined and the link shows by cursor and hover', () => {
    const style = INDEX_HTML.slice(INDEX_HTML.indexOf('#rv-demo-notice {'), INDEX_HTML.indexOf('</style>', INDEX_HTML.indexOf('#rv-demo-notice {')));
    expect(style).toContain('text-decoration: none');
    expect(style).not.toMatch(/text-decoration:\s*underline/);
    expect(style).toContain('cursor: pointer');
    expect(style).toContain('#rv-demo-notice:hover');
  });

  it('is aligned to the HMI chrome: right 8px, 8px above the bottom-right toolbar', () => {
    expect(INDEX_HTML).toMatch(/#rv-demo-notice \{[^}]*bottom: 38px;[^}]*right: 8px;/);
  });

  it('steps aside while a toolbar tooltip is open (the tooltip would sit behind it)', () => {
    const rule = INDEX_HTML.slice(INDEX_HTML.indexOf("body:has(.MuiTooltip-popper) #rv-demo-notice {"));
    expect(rule.startsWith('body:has(')).toBe(true);
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toContain('opacity: 0;');
    expect(body).toContain('pointer-events: none;');
    // the rule lives in the notice's own style block, so the strip removes it with the notice
    expect(stripDemoNotice(INDEX_HTML)).not.toContain('MuiTooltip-popper');
  });

  it('the customer-workspace guard refuses a delivery build that carries the notice', () => {
    const gen = readFileSync(resolve(ROOT, 'scripts', 'generate-customer-workspace.mjs'), 'utf8');
    expect(gen).toContain("includes('rv-watermark')");
    expect(gen).toContain("includes('rv-demo-notice')");
  });

  it('the recording hides it like the watermark', () => {
    const rec = readFileSync(resolve(ROOT, 'src', 'core', 'engine', 'rv-recording-hmi.ts'), 'utf8');
    expect(rec).toContain('#rv-watermark,#rv-demo-notice,');
  });
});
