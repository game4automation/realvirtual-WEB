// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-562 §9.9 — the Add-Interface dialog asks for the write permission.
 *
 * CONNECT's own default stays `false` for the API and for config files: a live
 * machine is never written to because somebody forgot a flag. But the one moment
 * a human DECIDES what a new PLC link may do is the moment he creates it, so the
 * dialog asks there, with "yes" preselected — virtual commissioning is what
 * nearly every new interface is for, and a viewer that cannot write is the exact
 * failure this plan exists to remove.
 *
 * Pinned: picking a type no longer creates anything on its own, the question step
 * appears with the checkbox on and the live-machine hint beside it, and the
 * answer reaches the POST body as `allowWebToPlc` either way.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import {
  fetchInterfaceTypes,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';
import { AddInterfaceDialog } from '../src/core/hmi/ConnectPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';

const manualSchema = {
  supportsDiscovery: true, supportsManualAdd: true, addressValidatable: false,
  directionFromAddress: false, addressLabel: 'Address', addressHint: '',
  addressExamples: ['%I0.0'], dataTypes: ['Bool'],
};

interface Posted { url: string; body: Record<string, unknown> }

let posts: Posted[] = [];

function installCatalog(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.endsWith('/interface-types')) {
      return json({ types: [{
        type: 'PlcSimAdvanced',
        label: 'Siemens PLCSIM Advanced',
        description: 'Virtual S7 controller',
        defaults: { updateCycleMs: 10 },
        signals: manualSchema,
      }] });
    }
    if (url.endsWith('/config/interfaces') && (init?.method ?? 'GET').toUpperCase() === 'POST') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
      posts.push({ url, body });
      return json({ ...body, signals: [] });
    }
    return json({});
  }));
}

function renderDialog() {
  const onCreated = vi.fn();
  render(
    <ThemeProvider theme={rvDarkTheme}>
      <AddInterfaceDialog open onClose={() => {}} onCreated={onCreated} />
    </ThemeProvider>,
  );
  return onCreated;
}

async function pickType(): Promise<void> {
  await act(async () => { screen.getByTestId('add-interface-row-PlcSimAdvanced').click(); });
}

/** The checkbox input of the write-permission question. */
function allowCheckbox(): HTMLInputElement {
  return screen.getByTestId('add-interface-allow-writes').querySelector('input') as HTMLInputElement;
}

beforeEach(async () => {
  posts = [];
  localStorage.clear();
  _resetConnectStore();
  installCatalog();
  await fetchInterfaceTypes();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  _resetConnectStore();
  localStorage.clear();
});

describe('AddInterfaceDialog — write permission question (plan-562 §9.9)', () => {
  it('asks after the type pick instead of creating the interface right away', async () => {
    renderDialog();
    await pickType();

    expect(screen.getByText('Allow realvirtual WEB to write inputs to the PLC?')).toBeTruthy();
    expect(screen.getByText(
      'Leave on for virtual commissioning. Turn off if the target is a live machine.',
    )).toBeTruthy();
    // Preselected — and nothing has been created yet.
    expect(allowCheckbox().checked).toBe(true);
    expect(posts).toEqual([]);
  });

  it('posts allowWebToPlc: true with the checkbox left on', async () => {
    const onCreated = renderDialog();
    await pickType();
    await act(async () => { screen.getByRole('button', { name: 'Create' }).click(); });

    expect(posts).toHaveLength(1);
    expect(posts[0].body.allowWebToPlc).toBe(true);
    expect(posts[0].body.type).toBe('PlcSimAdvanced');
    // The type defaults still ride along (nothing was replaced by the question).
    expect(posts[0].body.updateCycleMs).toBe(10);
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it('posts allowWebToPlc: false when the user turns it off for a live machine', async () => {
    renderDialog();
    await pickType();
    await act(async () => { allowCheckbox().click(); });
    expect(allowCheckbox().checked).toBe(false);
    await act(async () => { screen.getByRole('button', { name: 'Create' }).click(); });

    expect(posts).toHaveLength(1);
    expect(posts[0].body.allowWebToPlc).toBe(false);
  });

  it('Back returns to the type list and leaves the answer at its default', async () => {
    renderDialog();
    await pickType();
    await act(async () => { allowCheckbox().click(); });
    await act(async () => { screen.getByRole('button', { name: 'Back' }).click(); });

    expect(screen.getByTestId('add-interface-row-PlcSimAdvanced')).toBeTruthy();
    await pickType();
    expect(allowCheckbox().checked).toBe(true);
    expect(posts).toEqual([]);
  });
});
