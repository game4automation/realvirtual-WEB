// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-agpl-attribution — the AGPL notice of the viewer, per build stage (plan-679 Phase 9).
 *
 * ## The rule (Thomas, D14)
 *
 * The "Powered by realvirtual WEB · AGPL-3.0" watermark, the noscript "Source on GitHub (AGPL-3.0)"
 * link and the JSON-LD `license` field appear EXACTLY in a pure AGPL / community build — a build
 * without the private tree (GitHub mirror, `VITE_PUBLIC_BUILD=1`, a `core` workspace without
 * private code). Every build WITH the private tree — the demo (ADR-047), a commercial customer
 * workspace (dev server and build), a hosted customer deploy, our dev checkouts — carries none of
 * them: such a build contains code that is not in the public repository, and its users hold a
 * commercial licence (`hosting/licensing.md`: "The attribution has to go" presumes exactly that).
 *
 * ## No switch for everyone (D10)
 *
 * The answer comes from the build stage — "is private code compiled in" — which `vite.config.ts`
 * already knows as `HAS_PRIVATE`. It is deliberately NOT an environment variable: `RV_COMMERCIAL`
 * keeps steering installability only and no longer touches the notice.
 *
 * ## Gone, not hidden
 *
 * Without the notice the HTML transform REMOVES the three pieces; there is no runtime
 * `display: none`. The transform has no `apply: 'build'`, so the dev server (how a customer usually
 * runs a delivered workspace, via start.ps1 or CONNECT) serves the same HTML as the build.
 *
 * ## The demo notice (Thomas, 2026-11-02)
 *
 * The public demo (web.realvirtual.io/demo, ADR-047) is a build WITH the private tree, so it has
 * no AGPL watermark. In that very corner it shows "realvirtual public demo for evaluation",
 * linking to the editions page (#rv-demo-notice). It is switched on by ONE explicit flag,
 * `RV_DEMO_NOTICE=1`, which only the demo build mode sets (runBuild / buildEnvForMode, mode
 * "demo" AND the effective target path `demo`, same decision as the welcome window; /dev and
 * /demo-beta do not carry it) and which is never inherited.
 * It additionally needs the private tree. Customer workspaces, hosted customer deploys, dev
 * checkouts and pure AGPL builds do not carry it: the transform removes the element, same
 * "gone, not hidden" rule as for the watermark. At most one of the two notices is ever present.
 *
 * The third-party notices (plan-544: THIRD-PARTY-NOTICES.txt and the "Open-source licenses" link)
 * are untouched in every build.
 */

//! True when the build shows the AGPL notice: a pure AGPL/community build, i.e. no private tree.
export function agplAttributionEnabled({ hasPrivate }) {
  return !hasPrivate;
}

//! True when the build shows the demo notice: the private tree is compiled in AND the demo build
//! mode set the explicit flag. `demoFlag` is `process.env.RV_DEMO_NOTICE === '1'`, read by the caller.
export function demoNoticeEnabled({ hasPrivate, demoFlag }) {
  return Boolean(hasPrivate) && demoFlag === true;
}

/** Derive the terms gate from the build stage; tests never require consent (plan-2209). */
export function termsGateMode({ command, hasPrivate, demoFlag, privateBuild, customerWorkspace, isTest }) {
  if (isTest) return 'off';
  if (command === 'build') return hasPrivate && demoFlag && !privateBuild ? 'demo' : 'off';
  return command === 'serve' && hasPrivate && customerWorkspace ? 'developer' : 'off';
}

const WATERMARK_COMMENT = /[ \t]*<!--\s*AGPL Watermark[\s\S]*?-->[ \t]*\r?\n?/;
const NOSCRIPT_SOURCE_LINK = /\r?\n[ \t]*<a href="[^"]*">Source on GitHub \(AGPL-3\.0\)<\/a>[ \t]*·/;
const JSON_LD_LICENSE = /^[ \t]*"license":\s*"https:\/\/www\.gnu\.org\/licenses\/agpl-3\.0\.html",[ \t]*\r?\n/m;

/**
 * Removes the watermark (comment, anchor and its style block), the noscript source link and the
 * JSON-LD licence line from `index.html`. Idempotent; leaves everything else byte-identical.
 */
export function stripAgplAttribution(html) {
  let out = String(html);
  const anchorStart = out.indexOf('<a id="rv-watermark"');
  if (anchorStart >= 0) {
    // Back up over the "AGPL Watermark" comment right before the anchor, if there is one.
    let start = anchorStart;
    const before = out.slice(0, anchorStart);
    const comment = before.match(new RegExp(`${WATERMARK_COMMENT.source}[ \\t]*$`));
    if (comment) start = anchorStart - comment[0].length;
    else start = before.length - (before.match(/[ \t]*$/)?.[0].length ?? 0);
    let end = out.indexOf('</a>', anchorStart);
    end = end < 0 ? out.length : end + '</a>'.length;
    // The style block that follows belongs to the watermark when it styles #rv-watermark.
    const rest = out.slice(end);
    const style = rest.match(/^\s*<style>([\s\S]*?)<\/style>/);
    if (style && style[1].includes('#rv-watermark')) end += style[0].length;
    const trailing = out.slice(end).match(/^[ \t]*\r?\n/);
    if (trailing) end += trailing[0].length;
    out = out.slice(0, start) + out.slice(end);
  }
  out = out.replace(NOSCRIPT_SOURCE_LINK, '');
  out = out.replace(JSON_LD_LICENSE, '');
  return out;
}

/**
 * Removes the demo notice (comment, anchor and its style block) from `index.html`.
 * Idempotent; leaves everything else byte-identical.
 */
export function stripDemoNotice(html) {
  const out = String(html);
  const anchorStart = out.indexOf('<a id="rv-demo-notice"');
  if (anchorStart < 0) return out;
  const before = out.slice(0, anchorStart);
  const comment = before.match(/[ \t]*<!--\s*Demo notice[\s\S]*?-->[ \t]*\r?\n[ \t]*$/);
  const start = comment ? anchorStart - comment[0].length : before.length - (before.match(/[ \t]*$/)?.[0].length ?? 0);
  let end = out.indexOf('</a>', anchorStart);
  end = end < 0 ? out.length : end + '</a>'.length;
  const style = out.slice(end).match(/^\s*<style>([\s\S]*?)<\/style>/);
  if (style && style[1].includes('#rv-demo-notice')) end += style[0].length;
  const trailing = out.slice(end).match(/^[ \t]*\r?\n/);
  if (trailing) end += trailing[0].length;
  return out.slice(0, start) + out.slice(end);
}

//! The Vite plugin: no `apply`, so it runs for `serve` and `build` alike. `demoNotice` (default
//! false) keeps the demo notice; every other build drops it.
export function agplAttributionPlugin(enabled, { demoNotice = false } = {}) {
  return {
    name: 'rv-agpl-attribution',
    transformIndexHtml(html) {
      const out = enabled ? html : stripAgplAttribution(html);
      return demoNotice ? out : stripDemoNotice(out);
    },
  };
}
