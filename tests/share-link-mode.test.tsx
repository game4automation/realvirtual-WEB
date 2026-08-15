// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The shared link carries the receiver's workspace (plan-423 §9.3, F5).
 *
 * Both link builders have accepted an `opts.mode` since plan-386 — the dialog
 * simply never passed one, so every receiver landed in whatever workspace HIS
 * localStorage last remembered (usually the operator HMI of a machine he has
 * never seen). plan-387 F8 was only half-redeemed because of it.
 *
 * The matrix below is deliberately the full cross product the review asked for
 * — upload/own-URL × with/without `linkBase` × viewer/commissioning — because
 * the two call sites used to build their options object SEPARATELY and
 * conditionally, which is exactly the shape where one branch keeps the setting
 * and the other quietly drops it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import type { ComponentProps } from 'react';

import { ShareDialog } from '../src/core/share/ShareDialog';
import { setShareSession, SHARE_DRAFT_KEY } from '../src/core/share/rv-share-session';
import shareDialogSource from '../src/core/share/ShareDialog.tsx?raw';

const uploadSharedGlb = vi.hoisted(() => vi.fn(async () => ({
  id: 'sh_ABC123', expiresAt: undefined, url: 'https://storage.example.org/x.glb',
})));

// Only the upload call is stubbed — the module also carries `listMyShares` /
// `deleteShare`, which the dialog's "My shared links" panel imports.
vi.mock('../src/core/share/rv-share-upload', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/share/rv-share-upload')>(),
  uploadSharedGlb,
}));

const BASE = 'https://web.realvirtual.io/viewer';
const OWN_URL = 'https://files.example.org/pick and place.glb';
/** What `validateShareUrl` makes of it — the space is normalised, not dropped. */
const OWN_URL_NORMALISED = 'https://files.example.org/pick%20and%20place.glb';

function open(props: Partial<ComponentProps<typeof ShareDialog>> = {}) {
  render(
    <ShareDialog
      open
      onClose={() => {}}
      getBytes={() => new ArrayBuffer(8)}
      {...props}
    />,
  );
}

const testId = (id: string) => screen.getByTestId(id) as HTMLInputElement;

/** Pick the receiver's workspace in the dialog. */
function chooseMode(mode: 'viewer' | 'commissioning') {
  fireEvent.click(testId(`share-mode-${mode}`));
}

async function submitAndReadLink(): Promise<string> {
  fireEvent.click(screen.getByTestId('share-submit'));
  await waitFor(() => expect(screen.getByTestId('share-link')).toBeTruthy());
  return testId('share-link').value;
}

/** The own-URL path: no login, no terms, no upload. */
async function shareOwnUrl(mode: 'viewer' | 'commissioning', linkBase?: string): Promise<string> {
  open(linkBase ? { linkBase } : {});
  fireEvent.click(testId('share-target-own'));
  fireEvent.change(testId('share-own-url'), { target: { value: OWN_URL } });
  chooseMode(mode);
  return submitAndReadLink();
}

/** The upload path: signed in, terms ticked, upload stubbed. */
async function shareUpload(mode: 'viewer' | 'commissioning', linkBase?: string): Promise<string> {
  setShareSession({
    token: 't', email: 'sender@example.org',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  open(linkBase ? { linkBase } : {});
  fireEvent.click(testId('share-terms'));
  chooseMode(mode);
  return submitAndReadLink();
}

beforeEach(() => {
  localStorage.removeItem(SHARE_DRAFT_KEY);
  setShareSession(null);
  uploadSharedGlb.mockClear();
});

afterEach(() => {
  cleanup();
  setShareSession(null);
  localStorage.removeItem(SHARE_DRAFT_KEY);
});

// ─── The default ──────────────────────────────────────────────────────────

describe('shareLink_DefaultsToViewer', () => {
  it('the dialog opens on "View only"', () => {
    open({ linkBase: BASE });
    expect(testId('share-mode-viewer').checked).toBe(true);
    expect(testId('share-mode-commissioning').checked).toBe(false);
  });

  it('an unchanged dialog produces a viewer link', async () => {
    open({ linkBase: BASE });
    fireEvent.click(testId('share-target-own'));
    fireEvent.change(testId('share-own-url'), { target: { value: OWN_URL } });
    const link = await submitAndReadLink();
    expect(new URL(link).searchParams.get('mode')).toBe('viewer');
  });

  it('the choice is offered for BOTH targets, not only for uploads', () => {
    // The selector sits outside the `target === 'upload'` block on purpose: a
    // self-hosted GLB is shared for exactly the same two reasons.
    open({ linkBase: BASE });
    expect(screen.getByTestId('share-mode-commissioning')).toBeTruthy();
    fireEvent.click(testId('share-target-own'));
    expect(screen.getByTestId('share-mode-commissioning')).toBeTruthy();
  });
});

// ─── The matrix ───────────────────────────────────────────────────────────

describe('shareLink_CarriesTheChosenMode', () => {
  it('own URL × linkBase × viewer', async () => {
    const u = new URL(await shareOwnUrl('viewer', BASE));
    expect(u.origin + u.pathname).toBe(BASE);
    expect(u.searchParams.get('mode')).toBe('viewer');
    // The pre-423 component of the link is untouched — including the space in
    // the filename, which must survive encoded and not as a second parameter.
    expect(u.searchParams.get('glb')).toBe(OWN_URL_NORMALISED);
  });

  it('own URL × linkBase × commissioning', async () => {
    const u = new URL(await shareOwnUrl('commissioning', BASE));
    expect(u.searchParams.get('mode')).toBe('commissioning');
    expect(u.searchParams.get('glb')).toBe(OWN_URL_NORMALISED);
  });

  it('own URL × no linkBase × commissioning falls back to this page', async () => {
    const u = new URL(await shareOwnUrl('commissioning'));
    expect(u.origin + u.pathname).toBe(location.origin + location.pathname);
    expect(u.searchParams.get('mode')).toBe('commissioning');
  });

  it('upload × linkBase × viewer keeps the opaque id and adds the mode', async () => {
    const link = await shareUpload('viewer', BASE);
    const u = new URL(link);
    expect(u.origin + u.pathname).toBe(BASE);
    expect(u.searchParams.get('glb')).toBe('s:sh_ABC123');
    expect(u.searchParams.get('mode')).toBe('viewer');
    // Still a VIEWER link: the storage URL the upload returned is not in it.
    expect(link).not.toContain('storage.example.org');
  });

  it('upload × linkBase × commissioning', async () => {
    const u = new URL(await shareUpload('commissioning', BASE));
    expect(u.searchParams.get('glb')).toBe('s:sh_ABC123');
    expect(u.searchParams.get('mode')).toBe('commissioning');
  });

  it('upload × no linkBase × commissioning', async () => {
    const u = new URL(await shareUpload('commissioning'));
    expect(u.origin + u.pathname).toBe(location.origin + location.pathname);
    expect(u.searchParams.get('mode')).toBe('commissioning');
  });
});

// ─── The wiring itself ────────────────────────────────────────────────────

describe('shareLink_OptionsAreBuiltOnce', () => {
  it('both builders receive the SAME options object', () => {
    // Source guard (review finding SOL-R1 F8): the two call sites each used to
    // build `linkBase ? { base } : undefined` for themselves. One shared object
    // is what keeps a third setting from reaching only one of them.
    expect(shareDialogSource).toContain('buildShareViewerLink(result.id, linkOptions)');
    expect(shareDialogSource).toContain('buildOwnUrlShareLink(ownUrl, linkOptions)');
    expect(shareDialogSource).not.toContain('linkBase ? { base: linkBase } : undefined');
  });

  it('the mode is part of the memo dependencies of both callbacks', () => {
    // Without `linkOptions` in the dependency lists, the first render's mode is
    // captured and the radio button does nothing — the defect this pins is
    // invisible in the UI and only shows in the produced link.
    expect(shareDialogSource).toContain('[linkBase, recipientMode]');
    expect(shareDialogSource).toContain('[getBytes, meta, expiry, allowDownload, name, linkOptions]');
    expect(shareDialogSource).toContain('[target, ownUrl, terms, persistDraft, doUpload, linkOptions]');
  });
});
