// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for rv-agpl-attribution.mjs (plan-679 Phase 9). */

/** True when the build shows the AGPL notice: a pure AGPL/community build (no private tree). */
export function agplAttributionEnabled(input: { hasPrivate: boolean }): boolean;
/** Removes watermark, noscript source link and JSON-LD licence from index.html. */
export function stripAgplAttribution(html: string): string;
/** True when the build shows the demo notice: private tree AND the explicit RV_DEMO_NOTICE flag. */
export function demoNoticeEnabled(input: { hasPrivate: boolean; demoFlag: boolean }): boolean;
/** Terms gate derived from the build stage; tests always disable it (plan-2209). */
export function termsGateMode(input: {
  command: string;
  hasPrivate: boolean;
  demoFlag: boolean;
  privateBuild: boolean;
  customerWorkspace: boolean;
  isTest: boolean;
}): 'off' | 'demo' | 'developer';
/** Removes the demo notice (#rv-demo-notice) from index.html. */
export function stripDemoNotice(html: string): string;
/** The Vite plugin (serve and build). */
export function agplAttributionPlugin(enabled: boolean, options?: { demoNotice?: boolean }): {
  name: string;
  apply?: 'build' | 'serve';
  transformIndexHtml(html: string): string;
};
