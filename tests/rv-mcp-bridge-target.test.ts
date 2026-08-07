// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-bridge-target.test.ts — MCP bridge WebSocket target derivation
 * (plan-286 Phase 4, plan-327 AP5).
 *
 * Validates the pure `resolveMcpBridgeTarget()` helper:
 * - embedded (CONNECT same-origin) → ws(s)://<host>/webviewer
 * - explicit / dev → ws://localhost:<port>/webviewer (+ ?apikey)
 * - the auth token is transport-independent (AP5): it must be able to travel on
 *   BOTH paths, because the Vite-dev browser reaching a key-protected CONNECT is
 *   exactly the case that used to be silently rejected with 401.
 * - plan-366: embedded is same-origin, so the key stays OUT of the URL and the
 *   handshake rides on CONNECT's session cookie — until `preferCookieAuth: false`
 *   says that failed, which brings the query key back.
 * - the default port is CONNECT (5100); the Node ports stay reachable as fallback.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveMcpBridgeTarget,
  DEFAULT_BRIDGE_PORT,
  NODE_FALLBACK_PORT,
  type McpBridgeTargetContext,
} from '../src/plugins/mcp-bridge-plugin';

/** Base context: CONNECT-embedded, http, no token, no explicit port, production
 *  cookie preference (the plugin passes `!_cookieAuthFailed`, i.e. true at start). */
function ctx(overrides: Partial<McpBridgeTargetContext> = {}): McpBridgeTargetContext {
  return {
    protocol: 'http:',
    host: 'plant.example.com:8443',
    isDevServer: false,
    explicitPort: false,
    bridgePort: DEFAULT_BRIDGE_PORT,
    authToken: undefined,
    preferCookieAuth: true,
    ...overrides,
  };
}

describe('resolveMcpBridgeTarget', () => {
  it('embedded same-origin (http) → ws://<host>/webviewer, no apikey', () => {
    expect(resolveMcpBridgeTarget(ctx())).toBe('ws://plant.example.com:8443/webviewer');
  });

  // plan-366: same-origin, so CONNECT's SameSite=Strict session cookie is sent with
  // the handshake and the credential does not have to sit in a logged URL.
  it('embedded same-origin keeps the key OUT of the URL and relies on the cookie', () => {
    expect(resolveMcpBridgeTarget(ctx({ authToken: 'sEcReT tok/en' }))).toBe(
      'ws://plant.example.com:8443/webviewer',
    );
  });

  // ... but it is a preference, not a removal: an expired cookie closes the
  // handshake without opening, and the next attempt must carry the key again.
  it('embedded falls back to ?apikey once the cookie attempt failed', () => {
    expect(
      resolveMcpBridgeTarget(ctx({ authToken: 'sEcReT tok/en', preferCookieAuth: false })),
    ).toBe('ws://plant.example.com:8443/webviewer?apikey=sEcReT%20tok%2Fen');
  });

  it('empty auth token does NOT append a query', () => {
    expect(resolveMcpBridgeTarget(ctx({ authToken: '' }))).toBe(
      'ws://plant.example.com:8443/webviewer',
    );
  });

  it('https origin → wss scheme', () => {
    expect(resolveMcpBridgeTarget(ctx({ protocol: 'https:' }))).toBe(
      'wss://plant.example.com:8443/webviewer',
    );
  });

  it('https + auth token → wss, cookie-preferred (no ?apikey)', () => {
    expect(
      resolveMcpBridgeTarget(ctx({ protocol: 'https:', authToken: 'abc123' })),
    ).toBe('wss://plant.example.com:8443/webviewer');
  });

  it('https + auth token after a failed cookie attempt → wss with ?apikey', () => {
    expect(
      resolveMcpBridgeTarget(
        ctx({ protocol: 'https:', authToken: 'abc123', preferCookieAuth: false }),
      ),
    ).toBe('wss://plant.example.com:8443/webviewer?apikey=abc123');
  });

  it('the default bridge port is CONNECT, not a Node bridge', () => {
    expect(DEFAULT_BRIDGE_PORT).toBe('5100');
    expect(NODE_FALLBACK_PORT).toBe('18714');
  });

  // Since plan-363 the browser no longer sees the Vite port at all — CONNECT proxies the dev
  // server under its own. The dev branch is unchanged by that (it was never derived from the
  // page origin), which is exactly why the `port === '5173'` companion of `import.meta.env.DEV`
  // could be dropped in Phase 7: the host these cases carry is now CONNECT's, and the result is
  // the same either way.
  it('dev build with no pinned port → CONNECT on localhost:5100', () => {
    expect(
      resolveMcpBridgeTarget(ctx({ host: 'localhost:15363', isDevServer: true })),
    ).toBe('ws://localhost:5100/webviewer');
  });

  // The AP5 defect, pinned: the dev branch used to drop the token, so a
  // key-protected CONNECT rejected the handshake and could not be the dev default.
  // The plan-366 cookie preference must NOT reintroduce it: the dev branch aims at a
  // localhost gateway that may not be the page origin, so the query key is the only
  // proof a browser can present there.
  it('dev build → CONNECT carries the ?apikey token even with cookie preference on', () => {
    expect(
      resolveMcpBridgeTarget(
        ctx({ host: 'localhost:15363', isDevServer: true, authToken: 'dev key/1' }),
      ),
    ).toBe('ws://localhost:5100/webviewer?apikey=dev%20key%2F1');
  });

  it('dev path ignores the same-origin host and the page scheme', () => {
    expect(
      resolveMcpBridgeTarget(
        ctx({ host: 'localhost:15363', isDevServer: true, protocol: 'https:' }),
      ),
    ).toBe('ws://localhost:5100/webviewer');
  });

  it('explicitly pinned port → localhost bridge even when not the dev server', () => {
    expect(
      resolveMcpBridgeTarget(ctx({ explicitPort: true, bridgePort: '19000' })),
    ).toBe('ws://localhost:19000/webviewer');
  });

  it('pinned Node fallback port overrides same-origin derivation but keeps the token', () => {
    expect(
      resolveMcpBridgeTarget(
        ctx({
          explicitPort: true,
          bridgePort: NODE_FALLBACK_PORT,
          protocol: 'https:',
          authToken: 'x',
        }),
      ),
    ).toBe('ws://localhost:18714/webviewer?apikey=x');
  });
});
