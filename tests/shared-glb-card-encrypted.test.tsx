// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-560 §9.7 — the shared-link card for an encrypted share: an "Encrypted"
 * row, a download that says it hands out the encrypted file, and no follow-up
 * action that would re-fetch the URL without its key.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';

import { SharedGlbInfoCard } from '../src/core/share/SharedGlbInfoCard';
import { SharedGlbInfoCardHost } from '../src/core/share/share-plugin';
import { buildSharedGlbInfo } from '../src/core/share/rv-share-meta';
import { setSharedGlb, clearSharedGlb } from '../src/core/share/rv-share-store';

const URL_ = 'https://files.example.org/model.rve.glb';
const payload = { bytes: new Uint8Array([0x52, 0x56, 0x45, 0x31]).buffer, finalUrl: URL_, contentType: null };

afterEach(() => {
  cleanup();
  clearSharedGlb();
});

describe('SharedGlbInfoCard — encrypted share (plan-560)', () => {
  it('shows the Encrypted row and the encrypted download label', () => {
    const info = buildSharedGlbInfo({ url: URL_, encrypted: true });
    render(createElement(SharedGlbInfoCard, { info, onDownload: () => {} }));
    expect(screen.getByTestId('shared-glb-encrypted').textContent).toMatch(/Encrypted/);
    expect(screen.getByTestId('shared-glb-download').textContent).toBe('Download (encrypted)');
    expect(info.name).toBe('model');
  });

  it('host: offers no Open-in-App, Add-to-Library or bookmark element for an encrypted share', () => {
    setSharedGlb(buildSharedGlbInfo({ url: URL_, encrypted: true }), payload);
    render(createElement(SharedGlbInfoCardHost));
    expect(screen.getByTestId('shared-glb-info-card')).toBeTruthy();
    expect(screen.queryByTestId('shared-glb-open-in-app')).toBeNull();
    expect(screen.queryByTestId('shared-glb-bookmark')).toBeNull();
    expect(screen.getByTestId('shared-glb-download').textContent).toBe('Download (encrypted)');
  });

  it('host: an unencrypted share is unchanged (all actions, "GLB" label, no Encrypted row)', () => {
    setSharedGlb(buildSharedGlbInfo({ url: 'https://files.example.org/model.glb' }), payload);
    render(createElement(SharedGlbInfoCardHost));
    expect(screen.getByTestId('shared-glb-open-in-app')).toBeTruthy();
    expect(screen.getByTestId('shared-glb-bookmark')).toBeTruthy();
    expect(screen.getByTestId('shared-glb-download').textContent).toBe('GLB');
    expect(screen.queryByTestId('shared-glb-encrypted')).toBeNull();
  });
});
