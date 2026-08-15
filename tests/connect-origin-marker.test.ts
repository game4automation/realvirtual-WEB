// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  deriveDefaultGatewayUrl,
  defaultGatewayUrl,
  isServedByConnectOrigin,
  resolveInitialGatewayUrl,
  ORIGIN_MARKER_COOKIE,
  FALLBACK_GATEWAY_URL,
} from '../src/core/hmi/connect-store';

/**
 * The served-by-CONNECT marker (plan-426).
 *
 * The case it exists for: a second device on the LAN opens `http://192.168.x.y:5100/`. Its page
 * origin is not loopback, so the viewer would fall back to `localhost:5100` — its OWN localhost,
 * where nothing listens. It cannot simply treat every origin as the gateway either: a realvirtual
 * WEB hosted on a public origin genuinely does talk to a CONNECT somewhere else, and that group
 * needs exactly the fallback. Only CONNECT can tell the two apart, so it says so — with a cookie on
 * the document it serves — and this file pins that the viewer reads it and acts on it.
 */
describe('served-by-CONNECT origin marker', () => {
  const HOSTED = {
    protocol: 'https:', hostname: 'web.realvirtual.io', origin: 'https://web.realvirtual.io',
  };
  const LAN = {
    protocol: 'http:', hostname: '192.168.1.44', origin: 'http://192.168.1.44:5100',
  };
  const LOOPBACK = {
    protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:15363',
  };

  function clearMarker(): void {
    document.cookie = `${ORIGIN_MARKER_COOKIE}=; Max-Age=0; path=/`;
  }

  beforeEach(clearMarker);
  afterEach(clearMarker);

  describe('deriveDefaultGatewayUrl — pure, marker as an argument', () => {
    it('adopts the page origin when CONNECT served the page', () => {
      // The LAN second device: not loopback, and still the gateway.
      expect(deriveDefaultGatewayUrl(LAN, true)).toBe('http://192.168.1.44:5100');
    });

    it('keeps the localhost fallback for a hosted origin without the marker (group 4)', () => {
      expect(deriveDefaultGatewayUrl(HOSTED, false)).toBe(FALLBACK_GATEWAY_URL);
    });

    it('keeps a loopback origin as the gateway, marker or not', () => {
      // Unchanged behaviour: this is how every local installation has worked since plan-363.
      expect(deriveDefaultGatewayUrl(LOOPBACK, false)).toBe('http://localhost:15363');
      expect(deriveDefaultGatewayUrl(LOOPBACK, true)).toBe('http://localhost:15363');
    });

    it('still refuses an origin that names no reachable host, marker or not', () => {
      // A file:// or blob: page has no host to talk to; a stray cookie must not change that.
      const opaque = { protocol: 'file:', hostname: '', origin: 'null' };
      expect(deriveDefaultGatewayUrl(opaque, true)).toBe(FALLBACK_GATEWAY_URL);
    });
  });

  describe('isServedByConnectOrigin — the only place a cookie is read', () => {
    it('recognises the marker among other cookies', () => {
      expect(isServedByConnectOrigin(`a=b; ${ORIGIN_MARKER_COOKIE}=1; c=d`)).toBe(true);
      expect(isServedByConnectOrigin(`${ORIGIN_MARKER_COOKIE}=1`)).toBe(true);
    });

    it('is false without it, and for a cookie that merely looks like it', () => {
      expect(isServedByConnectOrigin('')).toBe(false);
      expect(isServedByConnectOrigin('a=b')).toBe(false);
      // Neither a different value nor a longer name may pass — an old CONNECT sets nothing, and
      // "something similar is set" is not the signal.
      expect(isServedByConnectOrigin(`${ORIGIN_MARKER_COOKIE}=0`)).toBe(false);
      expect(isServedByConnectOrigin(`${ORIGIN_MARKER_COOKIE}_x=1`)).toBe(false);
    });

    it('reads the real document.cookie when nothing is injected', () => {
      expect(isServedByConnectOrigin()).toBe(false);
      document.cookie = `${ORIGIN_MARKER_COOKIE}=1; path=/`;
      expect(isServedByConnectOrigin()).toBe(true);
    });
  });

  describe('defaultGatewayUrl — the wrapper', () => {
    it('never throws and always answers with a URL', () => {
      // The defensive contract: no document, no cookie access (a sandboxed iframe throws on
      // document.cookie), an exotic location — the store still boots with something usable.
      expect(() => defaultGatewayUrl()).not.toThrow();
      expect(defaultGatewayUrl()).toMatch(/^https?:\/\//);
    });

    it('answers the same as the pure function it wraps', () => {
      document.cookie = `${ORIGIN_MARKER_COOKIE}=1; path=/`;
      expect(defaultGatewayUrl())
        .toBe(deriveDefaultGatewayUrl(window.location, true));
    });
  });

  describe('bootstrap — what the store starts with', () => {
    it('adopts the page origin as serverUrl when the marker is set', () => {
      // The seam SOL asked to see proven: marker → derivation → the URL the store boots with. It
      // has to happen at module load, which is why the asynchronous app-config channel could not
      // carry the marker.
      expect(resolveInitialGatewayUrl(null, LAN, true)).toBe('http://192.168.1.44:5100');
    });

    it('leaves group 4 on its localhost gateway', () => {
      expect(resolveInitialGatewayUrl(null, HOSTED, false)).toBe(FALLBACK_GATEWAY_URL);
    });

    it('lets a remembered URL win over everything', () => {
      // A gateway the user typed is a decision; neither the marker nor the origin overrides it.
      expect(resolveInitialGatewayUrl('http://10.0.0.9:5100', LAN, true))
        .toBe('http://10.0.0.9:5100');
    });
  });
});
