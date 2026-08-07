// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, afterEach } from 'vitest';
import {
  isLocalGatewayTarget,
  canSilentlyProbeGateway,
  deriveDefaultGatewayUrl,
  hasUserConnectedBefore,
  FALLBACK_GATEWAY_URL,
} from '../src/core/hmi/connect-store';

describe('isLocalGatewayTarget', () => {
  it('classifies loopback and private targets as local', () => {
    expect(isLocalGatewayTarget('http://localhost:5100')).toBe(true);
    expect(isLocalGatewayTarget('http://127.0.0.1:5100')).toBe(true);
    expect(isLocalGatewayTarget('http://[::1]:5100')).toBe(true);
    expect(isLocalGatewayTarget('http://192.168.1.20:5100')).toBe(true);
    expect(isLocalGatewayTarget('http://10.0.0.5:5100')).toBe(true);
    expect(isLocalGatewayTarget('http://172.16.0.1:5100')).toBe(true);
    expect(isLocalGatewayTarget('http://172.31.255.1:5100')).toBe(true);
    expect(isLocalGatewayTarget('http://169.254.10.10:5100')).toBe(true);
    expect(isLocalGatewayTarget('http://gateway.local:5100')).toBe(true);
  });

  it('classifies public targets as non-local', () => {
    expect(isLocalGatewayTarget('https://connect.example.com')).toBe(false);
    expect(isLocalGatewayTarget('http://172.32.0.1:5100')).toBe(false);
    expect(isLocalGatewayTarget('http://11.0.0.1:5100')).toBe(false);
    expect(isLocalGatewayTarget('http://192.169.0.1:5100')).toBe(false);
  });

  it('treats unparseable URLs as non-local', () => {
    expect(isLocalGatewayTarget('not a url')).toBe(false);
    expect(isLocalGatewayTarget('')).toBe(false);
  });
});

describe('canSilentlyProbeGateway', () => {
  it('allows the probe on a loopback page origin', async () => {
    // Vitest browser mode serves from localhost — the loopback-origin
    // fast path must short-circuit before any Permissions API query.
    expect(window.location.hostname === 'localhost'
      || window.location.hostname === '127.0.0.1').toBe(true);
    await expect(canSilentlyProbeGateway()).resolves.toBe(true);
  });

  // The LNA path is NOT a leftover of the two-server era plan-363 ended: user group 4 keeps a
  // public page origin talking to a CONNECT on the operator's own machine. This asserts the pair
  // that makes that case real — a hosted origin, a local target — still classifies as before.
  it('keeps the hosted-page / local-gateway pair that user group 4 depends on', () => {
    expect(isLocalGatewayTarget('http://localhost:5100')).toBe(true);
    expect(isLocalGatewayTarget('https://web.realvirtual.io')).toBe(false);
  });
});

describe('hasUserConnectedBefore', () => {
  afterEach(() => localStorage.removeItem('rv-connect-user-connected'));

  // The auto-probe in ConnectPlugin.init requires this flag before contacting a LOCAL
  // gateway from a hosted origin: Chrome's LNA prompt belongs to the explicit Connect
  // click. A fresh browser must answer false, whatever canSilentlyProbeGateway says.
  it('is false in a fresh browser', () => {
    expect(hasUserConnectedBefore()).toBe(false);
  });

  it('reads the persisted flag an explicit successful connect records', () => {
    localStorage.setItem('rv-connect-user-connected', '1');
    expect(hasUserConnectedBefore()).toBe(true);
  });
});

describe('deriveDefaultGatewayUrl (plan-363 Phase 7)', () => {
  it('takes a loopback page origin as the gateway, port included', () => {
    // The reason the hard-coded :5100 had to go: a worktree CONNECT listens elsewhere, and the
    // page origin is the only thing that knows where.
    expect(deriveDefaultGatewayUrl({
      protocol: 'http:', hostname: 'localhost', origin: 'http://localhost:15363',
    })).toBe('http://localhost:15363');
    expect(deriveDefaultGatewayUrl({
      protocol: 'http:', hostname: '127.0.0.1', origin: 'http://127.0.0.1:5100',
    })).toBe('http://127.0.0.1:5100');
  });

  it('falls back to localhost:5100 for a hosted origin — group 4 never talks to itself', () => {
    expect(deriveDefaultGatewayUrl({
      protocol: 'https:', hostname: 'web.realvirtual.io', origin: 'https://web.realvirtual.io',
    })).toBe(FALLBACK_GATEWAY_URL);
  });

  it('falls back for a non-http origin (file://, blob:) that names no reachable host', () => {
    expect(deriveDefaultGatewayUrl({
      protocol: 'file:', hostname: '', origin: 'null',
    })).toBe(FALLBACK_GATEWAY_URL);
  });
});
