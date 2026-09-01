// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-446 §9.2 — when the project browser may offer "Show in Explorer".
 *
 * ## Why the rule is two conditions and not one
 *
 * CONNECT already refuses every non-loopback PEER (`RevealEndpointTests`), so one could argue the
 * client needs no rule at all. It does: a viewer opened from a tablet over a forwarded port IS a
 * loopback peer as far as the gateway can see, and the window it opens appears on the machine in
 * the plant. The second condition — the PAGE is local — is the only one that can tell those apart,
 * and it lives here because only the browser knows where it is.
 *
 * What is pinned: the rule itself, that a refusal retires the verb without a dialog, and that the
 * retirement reaches a rendered component without a reload — the "disappears on the next probe"
 * half of Phase 2.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  canRevealInExplorer,
  canRevealInExplorerNow,
  connectToServer,
  getConnectSnapshot,
  revealInExplorer,
  setServerUrl,
  subscribeConnectStore,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';

const SERVER = 'http://reveal-verb.test:5100';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Connects the store to a gateway that does (or does not) advertise the capability. */
async function connectGateway(revealSupported: boolean | undefined): Promise<void> {
  vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL) => {
    const url = String(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
    if (url.endsWith('/health')) {
      return json({ status: 'ok', version: '1.2.2', build: 1, ...(revealSupported === undefined ? {} : { revealSupported }) });
    }
    if (url.endsWith('/config/interfaces')) return json([]);
    if (url.endsWith('/interface-types')) return json({ types: [] });
    return new Response('', { status: 404 });
  }));
  setServerUrl(SERVER);
  await act(async () => { await connectToServer(); });
}

/**
 * The verb as the dashboard renders it — the same `canRevealInExplorerNow()` the host's memo calls,
 * subscribed to the same store. A copy of the RULE in here would test the copy; calling the shipped
 * helper is what makes the retirement below meaningful.
 */
function RevealVerb() {
  const snap = React.useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const visible = React.useMemo(
    () => canRevealInExplorerNow(),
    [snap.state, snap.revealSupported, snap.serverUrl],
  );
  return visible ? <button data-testid="reveal-verb">Show in Explorer</button> : null;
}

beforeEach(() => {
  localStorage.clear();
  _resetConnectStore();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  _resetConnectStore();
});

describe('canRevealInExplorer — capability AND a local page', () => {
  it('says no without the capability, whatever the origin', () => {
    expect(canRevealInExplorer(false, 'http://localhost:5100', {
      hostname: 'localhost', origin: 'http://localhost:5100',
    })).toBe(false);
  });

  it('says yes for a page served from loopback, in both spellings', () => {
    for (const hostname of ['localhost', '127.0.0.1']) {
      expect(canRevealInExplorer(true, 'http://localhost:5100', {
        hostname, origin: `http://${hostname}:5173`,
      })).toBe(true);
    }
  });

  //! The plan-363 arrangement: CONNECT serves the page itself, so page and gateway are one origin
  //! and therefore one machine — even when that origin is not spelled "localhost".
  it('says yes when the gateway origin IS the page origin', () => {
    expect(canRevealInExplorer(true, 'http://plant-pc:5100', {
      hostname: 'plant-pc', origin: 'http://plant-pc:5100',
    })).toBe(true);
  });

  //! The case the rule exists for: a remotely opened viewer driving a CONNECT somewhere else. The
  //! gateway would answer 204 and the window would open on a screen nobody is looking at.
  it('says no for a remote page pointing at a different origin', () => {
    expect(canRevealInExplorer(true, 'http://localhost:5100', {
      hostname: 'web.realvirtual.io', origin: 'https://web.realvirtual.io',
    })).toBe(false);
    expect(canRevealInExplorer(true, 'http://192.168.1.40:5100', {
      hostname: '192.168.1.77', origin: 'http://192.168.1.77:5173',
    })).toBe(false);
  });

  //! An origin change inside a running session (the same store, a different page location) flips
  //! the answer — the rule reads the location every time rather than caching a verdict.
  it('hides the verb the moment the page origin stops being local', () => {
    const local = { hostname: 'localhost', origin: 'http://localhost:5173' };
    const remote = { hostname: 'web.realvirtual.io', origin: 'https://web.realvirtual.io' };
    expect(canRevealInExplorer(true, 'http://localhost:5100', local)).toBe(true);
    expect(canRevealInExplorer(true, 'http://localhost:5100', remote)).toBe(false);
  });

  it('says no rather than throwing on an unusable gateway URL', () => {
    expect(canRevealInExplorer(true, 'not a url', {
      hostname: 'web.realvirtual.io', origin: 'https://web.realvirtual.io',
    })).toBe(false);
  });
});

describe('the capability flag itself', () => {
  it('is false for a gateway that omits it — an older CONNECT has no such route', async () => {
    await connectGateway(undefined);
    expect(getConnectSnapshot().revealSupported).toBe(false);
  });

  it('is false when the gateway says so — a headless or project-less install', async () => {
    await connectGateway(false);
    expect(getConnectSnapshot().revealSupported).toBe(false);
  });

  it('is true when the gateway advertises it', async () => {
    await connectGateway(true);
    expect(getConnectSnapshot().revealSupported).toBe(true);
  });

  it('is false again after a disconnect — the flag never outlives its gateway', async () => {
    await connectGateway(true);
    _resetConnectStore();
    expect(getConnectSnapshot().revealSupported).toBe(false);
    expect(canRevealInExplorerNow()).toBe(false);
  });
});

describe('a refusal retires the verb, silently', () => {
  /** Answers the reveal POST with `status` and records the request. */
  function stubReveal(status: number): { calls: Array<{ url: string; body: string }> } {
    const calls: Array<{ url: string; body: string }> = [];
    const original = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
      if (url.endsWith('/project/reveal')) {
        calls.push({ url, body: String(init?.body ?? '') });
        return status === 204
          ? new Response(null, { status: 204 })
          : json({ error: 'no' }, status);
      }
      return original(request as RequestInfo, init);
    }));
    return { calls };
  }

  it('sends the project-relative path and keeps the capability on success', async () => {
    await connectGateway(true);
    const { calls } = stubReveal(204);

    await expect(revealInExplorer('models/cell.glb')).resolves.toBe(true);

    expect(JSON.parse(calls[0].body)).toEqual({ path: 'models/cell.glb' });
    expect(getConnectSnapshot().revealSupported).toBe(true);
  });

  //! 403 (the page is no longer local), 404 (an older gateway, or the file is gone) and 409 (the
  //! project root was dropped) all mean the same thing to the UI: stop offering it. No dialog —
  //! a convenience that fails may cost nothing but its own menu entry.
  it.each([403, 404, 409, 500])('clears the capability on %i', async (status) => {
    await connectGateway(true);
    stubReveal(status);

    await expect(revealInExplorer('models/cell.glb')).resolves.toBe(false);

    expect(getConnectSnapshot().revealSupported).toBe(false);
    expect(canRevealInExplorerNow()).toBe(false);
  });

  //! A network failure says nothing about the capability — the unreachable-gateway state has its
  //! own owner, and clearing the flag here would hide the verb for good after one hiccup.
  it('leaves the capability alone when the request never arrives', async () => {
    await connectGateway(true);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    await expect(revealInExplorer('models/cell.glb')).resolves.toBe(false);

    expect(getConnectSnapshot().revealSupported).toBe(true);
  });

  //! The rendered half of Phase 2: the entry is gone on the next render, without a reload and
  //! without anything asking it to re-probe.
  it('removes the rendered verb after the refusal', async () => {
    await connectGateway(true);
    render(<RevealVerb />);
    expect(screen.getByTestId('reveal-verb')).toBeTruthy();

    stubReveal(403);
    await act(async () => { await revealInExplorer('models/cell.glb'); });

    expect(screen.queryByTestId('reveal-verb')).toBeNull();
  });

  it('never renders the verb for a gateway without the capability', async () => {
    await connectGateway(false);
    render(<RevealVerb />);
    expect(screen.queryByTestId('reveal-verb')).toBeNull();
  });
});
