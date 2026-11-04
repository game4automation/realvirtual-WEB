// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * terms-gate-boot.browser.test.ts — plan-2209 §9.4: the terms gate in the boot.
 *
 * main.ts cannot be imported here (its module body grabs the index.html DOM and
 * starts `init()` against the dev server), so the boot is covered in two halves:
 *
 *  1. The boot SOURCE (`main.ts?raw`): the terms gate is a guarded dynamic import
 *     that runs before the analytics gate and before `RVViewer.create`, with no
 *     static import; the boot's storage accesses all go through the never-
 *     throwing wrappers.
 *  2. The boot CHAIN at runtime, in the order main.ts runs it: terms gate →
 *     analytics gate → `RVViewer.create` → `loadModel` → `whenSceneReady`,
 *     including the case where `localStorage` AND `sessionStorage` throw on
 *     every access for the whole run (Safari private mode, blocked site data).
 *
 * Not covered here: main.ts's own module body and the parts of `init()` between
 * the gates and the first model load (project resolution, dashboard, plugins).
 *
 * The build define is `off` under vitest, so the chain passes `{ mode: 'demo' }`;
 * Playwright's `navigator.webdriver === true` is forced to false per test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import mainSource from '../src/main.ts?raw';
import { requireTermsConsent, resetTermsGateForTests, TERMS_GATE_ROOT_ID } from '../src/core/hmi/terms-gate';
import { hasTermsConsent, revokeTermsConsent } from '../src/core/hmi/terms-consent-store';
import { requireAnalyticsConsent } from '../src/core/hmi/consent-gate';
import { resetAnalyticsConsent, resetAnalyticsSessionDecline } from '../src/core/consent-store';
import { getAppConfig, setAppConfig } from '../src/core/rv-app-config';
import { readLocalStorage, removeLocalStorage, writeLocalStorage, TERMS_CONSENT_KEY } from '../src/core/hmi/rv-storage-keys';
import { resolveBootMode } from '../src/core/rv-boot-mode';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';

const ANALYTICS_GATE_ID = 'rv-consent-gate-root';
const FIXTURE = '/demo-realvirtual/DemoRealvirtualWeb.glb';

function setWebdriver(value: boolean): void {
  Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => value });
}

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs = 3000): Promise<T> {
  const start = performance.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (performance.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const accept = () => document.querySelector<HTMLElement>('[data-testid="rv-terms-gate-accept"]');

/** Make every access to window.localStorage / sessionStorage throw until restored. */
function blockStorage(): () => void {
  const blocked = (name: string) => ({
    configurable: true,
    get(): Storage { throw new DOMException(`Access to ${name} is denied`, 'SecurityError'); },
  });
  // Window attributes live on the global object itself: keep the originals to put back.
  const originals = (['localStorage', 'sessionStorage'] as const).map((name) => {
    const own = Object.getOwnPropertyDescriptor(window, name);
    Object.defineProperty(window, name, blocked(name));
    return [name, own] as const;
  });
  return () => {
    for (const [name, own] of originals) {
      if (own) Object.defineProperty(window, name, own);
      else delete (window as unknown as Record<string, unknown>)[name];
    }
  };
}

let savedConfig: ReturnType<typeof getAppConfig>;
let handle: TestViewerHandle | null = null;

beforeEach(() => {
  savedConfig = getAppConfig();
  revokeTermsConsent();
  resetAnalyticsConsent();
  resetAnalyticsSessionDecline();
  setWebdriver(false);
});

afterEach(async () => {
  handle?.dispose();
  handle = null;
  resetTermsGateForTests();
  await waitFor(() => document.getElementById(TERMS_GATE_ROOT_ID) === null);
  document.getElementById(ANALYTICS_GATE_ID)?.remove();
  setAppConfig(savedConfig);
  delete (navigator as unknown as Record<string, unknown>).webdriver;
  revokeTermsConsent();
  resetAnalyticsConsent();
  resetAnalyticsSessionDecline();
});

describe('boot source order (main.ts?raw)', () => {
  const termsAt = mainSource.indexOf('await requireTermsConsent();');
  const analyticsAt = mainSource.indexOf('await requireAnalyticsConsent();');
  const viewerAt = mainSource.indexOf('await RVViewer.create(');

  it('the terms gate runs before the analytics gate and before the viewer is created', () => {
    expect(termsAt).toBeGreaterThan(0);
    expect(analyticsAt).toBeGreaterThan(termsAt);
    expect(viewerAt).toBeGreaterThan(analyticsAt);
  });

  it('is a dynamic import behind the build define, never a static import', () => {
    expect(mainSource).toMatch(
      /if \(__RV_TERMS_GATE__ !== 'off'\) \{\s*const \{ requireTermsConsent \} = await import\('\.\/core\/hmi\/terms-gate'\);\s*await requireTermsConsent\(\);\s*\}/,
    );
    expect(mainSource).not.toMatch(/^import[^\n]*terms-gate/m);
    // No runtime exclusion (SOL): the define alone decides.
    const block = mainSource.slice(mainSource.indexOf('// --- Terms gate (plan-2209)'), analyticsAt);
    expect(block).not.toMatch(/hostedDeploy|lockedModeOf|webdriver/);
  });

  it('boot and model-load storage accesses go through the never-throwing wrappers', () => {
    // Every remaining mention of the raw storages is a comment, never a call.
    const rawCalls = mainSource.split('\n').filter((line) =>
      /\b(localStorage|sessionStorage)\s*\.\s*(getItem|setItem|removeItem|clear|key)\b/.test(line)
      && !/^\s*(\/\/|\*)/.test(line));
    expect(rawCalls).toEqual([]);
    expect(mainSource).toMatch(/params\.get\('renderer'\) \?\? readLocalStorage\(LS_KEY_RENDERER\)/);
    expect(mainSource).toMatch(/writeLocalStorage\(LS_KEY_MODEL, identityUrl\)/);
    expect(mainSource).toMatch(/const savedModel = readLocalStorage\(LS_KEY_MODEL\)/);
    expect(mainSource).toMatch(/removeLocalStorage\(LS_KEY_MODEL\)/);
  });
});

describe('boot chain at runtime (plan-2209 §9.4)', () => {
  it('(a) the analytics gate appears only after the terms were accepted', async () => {
    setAppConfig({ ...savedConfig, analytics: { googleAnalyticsId: 'G-TEST123' } });
    const order: string[] = [];
    const boot = (async () => {
      await requireTermsConsent({ mode: 'demo' });
      order.push('terms');
      const outcome = await requireAnalyticsConsent('');
      order.push(`analytics:${outcome}`);
    })();

    await waitFor(accept);
    expect(accept()!.textContent).toBe('Accept and start demo');
    expect(document.querySelector<HTMLAnchorElement>('[data-testid="rv-terms-gate-link"]')?.href)
      .toBe('https://realvirtual.io/en/terms/#part-b');
    await new Promise((r) => setTimeout(r, 20));
    expect(document.getElementById(ANALYTICS_GATE_ID)).toBeNull();
    expect(order).toEqual([]);

    accept()!.click();
    await waitFor(() => document.getElementById(ANALYTICS_GATE_ID));
    expect(order).toEqual(['terms']);
    expect(document.getElementById(TERMS_GATE_ROOT_ID)?.querySelector('[data-testid="rv-terms-gate"]') ?? null).toBeNull();

    // Two separate decisions: the terms accept did not grant analytics.
    const analyticsAccept = Array.from(document.getElementById(ANALYTICS_GATE_ID)!.querySelectorAll('button'))
      .find((b) => b.textContent === 'Accept')!;
    analyticsAccept.click();
    await boot;
    expect(order).toEqual(['terms', 'analytics:granted']);
  });

  it('(b) a deep link ?doc=…&mode=des#x is unchanged after Accept and still decides the boot mode', async () => {
    const original = window.location.href;
    const deepLink = `${window.location.pathname}?doc=doc_demo&mode=des#x`;
    window.history.replaceState(window.history.state, '', deepLink);
    try {
      const href = window.location.href;
      const p = requireTermsConsent({ mode: 'demo' });
      (await waitFor(accept)).click();
      await p;
      expect(window.location.href).toBe(href);
      expect(window.location.hash).toBe('#x');
      const params = new URLSearchParams(window.location.search);
      expect(params.get('doc')).toBe('doc_demo');
      const boot = resolveBootMode(
        { locked: null, url: params.get('mode'), hostedStart: null, published: null, resume: null },
        { has: () => true, peekRestoreTarget: (f = 'hmi') => f },
      );
      expect(boot).toEqual({ mode: 'des', source: 'url' });
    } finally {
      window.history.replaceState(window.history.state, '', original);
    }
  });

  it('(c) with permanently throwing storage the dialog appears and Accept continues to a loaded model', async () => {
    const errors: unknown[] = [];
    const onError = (e: ErrorEvent) => { errors.push(e.error ?? e.message); };
    const onRejection = (e: PromiseRejectionEvent) => { errors.push(e.reason); };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    const bytes = await (await fetch(FIXTURE)).arrayBuffer();

    const restore = blockStorage();
    try {
      expect(() => window.localStorage).toThrow();
      expect(() => window.sessionStorage).toThrow();

      // main.ts's storage wrappers degrade instead of throwing.
      expect(readLocalStorage('rv-webviewer-renderer')).toBeNull();
      expect(writeLocalStorage('rv-webviewer-last-model', 'x')).toBe(false);
      expect(() => removeLocalStorage('rv-webviewer-last-model')).not.toThrow();

      // Terms gate → dialog → Accept (held for this session only).
      const terms = requireTermsConsent({ mode: 'demo' });
      (await waitFor(accept)).click();
      await terms;
      expect(hasTermsConsent('demo')).toBe(true);

      // Analytics gate with no tracker configured, as on most deploys.
      setAppConfig({ ...savedConfig, analytics: undefined });
      expect(await requireAnalyticsConsent('')).toBe('not-configured');

      // Viewer creation and the first model load, still with blocked storage.
      handle = await createTestViewer('webgl');
      await handle.viewer.loadModel('DemoRealvirtualWeb.glb', { data: bytes.slice(0) });
      await handle.viewer.whenSceneReady();
      expect(handle.viewer.registry).toBeTruthy();
      expect(handle.viewer.scene.children.length).toBeGreaterThan(0);

      // Still blocked at the end — nothing silently restored it.
      expect(() => window.localStorage).toThrow();
    } finally {
      restore();
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    }
    expect(errors).toEqual([]);
    // Nothing was persisted: the accept lived in the session fallback only.
    expect(localStorage.getItem(TERMS_CONSENT_KEY)).toBeNull();
  }, 120_000);

  it('(d) navigator.webdriver === true skips the gate, writes no record and leaves storage unchanged', async () => {
    setWebdriver(true);
    localStorage.setItem('rv-boot-probe', '1');
    const before = { ...localStorage } as Record<string, string>;
    await requireTermsConsent({ mode: 'demo' });
    expect(document.getElementById(TERMS_GATE_ROOT_ID)).toBeNull();
    expect({ ...localStorage }).toEqual(before);
    expect(localStorage.getItem(TERMS_CONSENT_KEY)).toBeNull();
    localStorage.removeItem('rv-boot-probe');
  });
});
