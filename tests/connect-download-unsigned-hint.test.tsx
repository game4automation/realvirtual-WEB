// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { ConnectDownloadLinks, ConnectOpener } from '../src/core/hmi/ConnectPanel';
import {
  CONNECT_STABLE_DOWNLOAD_URL,
  __resetConnectDownloadsForTest,
  __setConnectDownloadsForTest,
} from '../src/core/hmi/connect-downloads';
import { rvDarkTheme } from '../src/core/hmi/theme';

afterEach(() => {
  cleanup();
  __resetConnectDownloadsForTest();
});

function themed(node: React.ReactNode) {
  return <ThemeProvider theme={rvDarkTheme}>{node}</ThemeProvider>;
}

const HINT = /not code-signed yet/;

describe('unsigned CONNECT build — SmartScreen hint at the download', () => {
  it('shows the hint next to the download links when the stable manifest is unsigned', () => {
    __setConnectDownloadsForTest({
      stable: { url: CONNECT_STABLE_DOWNLOAD_URL, version: '1.4.0', build: 47, buildDate: '2026-10-07', unsigned: true },
      beta: null,
      loaded: true,
    });
    render(themed(<ConnectDownloadLinks />));
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(screen.getByText('More info')).toBeTruthy();
    expect(screen.getByText('Run anyway')).toBeTruthy();
  });

  it('shows the hint in the acquisition opener', () => {
    __setConnectDownloadsForTest({
      stable: { url: CONNECT_STABLE_DOWNLOAD_URL, version: '1.4.0', build: 47, buildDate: '2026-10-07', unsigned: true },
      beta: null,
      loaded: true,
    });
    render(themed(<ConnectOpener failedUrl={null} />));
    expect(screen.getByText(HINT)).toBeTruthy();
  });

  it('shows no hint for a signed build or an unknown manifest', () => {
    __setConnectDownloadsForTest({
      stable: { url: CONNECT_STABLE_DOWNLOAD_URL, version: '1.4.0', build: 46, buildDate: '2026-10-05' },
      beta: null,
      loaded: true,
    });
    render(themed(<ConnectDownloadLinks />));
    expect(screen.queryByText(HINT)).toBeNull();
    cleanup();
    __resetConnectDownloadsForTest();
    render(themed(<ConnectOpener failedUrl={null} />));
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
