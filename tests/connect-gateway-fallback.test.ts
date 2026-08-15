// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The bare-Vite customer case: page opened on :5173 (Vite started by hand instead of through
 * CONNECT), so the derived gateway URL is the viewer's own origin. `/health` is then answered by
 * Vite's SPA fallback with `index.html` and the panel used to show the raw parser text
 * ("Unexpected token '<' ..."). The viewer must recognise that answer as "web server, not
 * gateway", ask CONNECT's own port once, and adopt it when it answers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  connectToServer,
  getConnectSnapshot,
  setServerUrl,
  shouldAdoptFallbackGateway,
  deriveDefaultGatewayUrl,
  FALLBACK_GATEWAY_URL,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';

const LS_KEY_URL = 'rv-connect-url';

/** The origin vitest serves from — exactly what `deriveDefaultGatewayUrl` returns here. */
const DERIVED_URL = window.location.origin;

function htmlResponse(): Response {
  return new Response('<!DOCTYPE html><html><body>viewer</body></html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Route every request by base URL. `/health` answers per `health`, every other CONNECT endpoint
 * answers with an empty JSON payload so the post-connect loads do not add noise.
 */
function mockGateways(health: Record<string, () => Response>): { urls: string[] } {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    urls.push(url);
    const base = Object.keys(health).find((candidate) => url.startsWith(`${candidate}/health`));
    if (base) return Promise.resolve(health[base]());
    if (url.includes('/health')) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(jsonResponse([]));
  });
  return { urls };
}

function healthUrls(urls: string[]): string[] {
  return urls.filter((url) => url.includes('/health'));
}

describe('connect gateway fallback (bare Vite on 5173)', () => {
  beforeEach(() => {
    localStorage.removeItem(LS_KEY_URL);
    _resetConnectStore();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.removeItem(LS_KEY_URL);
    _resetConnectStore();
  });

  it('connects without any extra request when the origin IS the gateway', async () => {
    // Normal case since plan-363: CONNECT serves the page, so /health answers JSON right away.
    // The fallback must stay completely invisible here - no second /health, no URL change.
    const { urls } = mockGateways({
      [DERIVED_URL]: () => jsonResponse({ status: 'ok', version: '6.3.0', build: 42 }),
    });

    await connectToServer();

    const snap = getConnectSnapshot();
    expect(snap.state).toBe('connected');
    expect(snap.serverUrl).toBe(DERIVED_URL);
    expect(snap.serverVersion).toBe('6.3.0');
    expect(healthUrls(urls)).toEqual([`${DERIVED_URL}/health`]);
    expect(healthUrls(urls).some((url) => url.startsWith(FALLBACK_GATEWAY_URL))).toBe(false);
  });

  it('adopts localhost:5100 when the derived URL serves the viewer instead of a gateway', async () => {
    const { urls } = mockGateways({
      [DERIVED_URL]: () => htmlResponse(),
      [FALLBACK_GATEWAY_URL]: () => jsonResponse({ status: 'ok', version: '6.3.1', build: 7 }),
    });

    await connectToServer();

    const snap = getConnectSnapshot();
    expect(snap.state).toBe('connected');
    expect(snap.errorMessage).toBe('');
    expect(snap.serverUrl).toBe(FALLBACK_GATEWAY_URL);
    expect(snap.serverVersion).toBe('6.3.1');
    // Persisted, so the next page load starts at the gateway right away.
    expect(localStorage.getItem(LS_KEY_URL)).toBe(FALLBACK_GATEWAY_URL);
    expect(healthUrls(urls)).toEqual([
      `${DERIVED_URL}/health`,
      `${FALLBACK_GATEWAY_URL}/health`,
    ]);
  });

  it('asks the fallback exactly once and never loops over repeated connect attempts', async () => {
    const { urls } = mockGateways({
      [DERIVED_URL]: () => htmlResponse(),
      [FALLBACK_GATEWAY_URL]: () => htmlResponse(),
    });

    await connectToServer();
    expect(healthUrls(urls)).toEqual([
      `${DERIVED_URL}/health`,
      `${FALLBACK_GATEWAY_URL}/health`,
    ]);

    // Second attempt: the URL was never replaced, so it repeats the same single pair - never more.
    await connectToServer();
    expect(healthUrls(urls)).toEqual([
      `${DERIVED_URL}/health`,
      `${FALLBACK_GATEWAY_URL}/health`,
      `${DERIVED_URL}/health`,
      `${FALLBACK_GATEWAY_URL}/health`,
    ]);
  });

  it('explains the state instead of leaking the JSON parser message when the fallback fails', async () => {
    // Nothing on 5100 either: the derived URL serves the viewer, the fallback refuses the connection.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      if (url.startsWith(`${FALLBACK_GATEWAY_URL}/health`)) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      if (url.includes('/health')) return Promise.resolve(htmlResponse());
      return Promise.resolve(jsonResponse([]));
    });

    await connectToServer();

    const snap = getConnectSnapshot();
    expect(snap.state).toBe('error');
    expect(snap.serverUrl).toBe(DERIVED_URL);
    // No parser wording, and the URL is NOT silently moved on a failed fallback.
    expect(snap.errorMessage).not.toMatch(/Unexpected token|not valid JSON/);
    expect(snap.errorMessage).toBe(
      `${DERIVED_URL} served the viewer, not the realvirtual CONNECT gateway. `
      + 'CONNECT is probably running on a different port - enter its address under the settings gear, '
      + `for example ${FALLBACK_GATEWAY_URL}.`,
    );
    expect(localStorage.getItem(LS_KEY_URL)).toBe(null);
  });

  it('never overrides a URL the user typed, not even when it serves HTML', async () => {
    const userUrl = 'http://localhost:6123';
    setServerUrl(userUrl);
    const { urls } = mockGateways({
      [userUrl]: () => htmlResponse(),
      [FALLBACK_GATEWAY_URL]: () => jsonResponse({ status: 'ok' }),
    });

    await connectToServer();

    const snap = getConnectSnapshot();
    expect(snap.state).toBe('error');
    expect(snap.serverUrl).toBe(userUrl);
    expect(localStorage.getItem(LS_KEY_URL)).toBe(userUrl);
    // The gateway on 5100 answers - and is still not asked, because nobody chose it.
    expect(healthUrls(urls)).toEqual([`${userUrl}/health`]);
  });
});

describe('shouldAdoptFallbackGateway', () => {
  it('adopts only for a derived URL that is not the fallback itself', () => {
    // Bare Vite: derived from the page origin, nothing stored.
    expect(shouldAdoptFallbackGateway('http://localhost:5173', 'http://localhost:5173', null))
      .toBe(true);
    // Same URL stored (from an earlier connect or a user typing exactly the origin) - still safe.
    expect(shouldAdoptFallbackGateway(
      'http://localhost:5173', 'http://localhost:5173', 'http://localhost:5173',
    )).toBe(true);
  });

  it('leaves a user-entered URL alone', () => {
    expect(shouldAdoptFallbackGateway(
      'http://plc-host:5100', 'http://localhost:5173', 'http://plc-host:5100',
    )).toBe(false);
  });

  it('does not re-ask the port it is already on', () => {
    expect(shouldAdoptFallbackGateway(FALLBACK_GATEWAY_URL, FALLBACK_GATEWAY_URL, null))
      .toBe(false);
  });

  it('keeps the hosted (non-loopback) origin on its 5100 default without a second attempt', () => {
    // A hosted page derives the fallback already, so there is nothing else to try.
    const derived = deriveDefaultGatewayUrl({
      protocol: 'https:', hostname: 'web.realvirtual.io', origin: 'https://web.realvirtual.io',
    }, false);
    expect(derived).toBe(FALLBACK_GATEWAY_URL);
    expect(shouldAdoptFallbackGateway(derived, derived, null)).toBe(false);
  });

  it('does not adopt for a worktree CONNECT session on its own port', () => {
    // 15363/15365 run THROUGH CONNECT: /health answers JSON, so this decision is never reached -
    // but even if it were, the stored URL from a previous session must not be swapped for 5100.
    expect(shouldAdoptFallbackGateway(
      'http://localhost:15363', 'http://localhost:15365', 'http://localhost:15363',
    )).toBe(false);
  });
});
