// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-370 §9.3 — URL construction, base-URL override, and the one helper that
 * both the button and F1 go through (F5, F6).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildHelpUrl, DEFAULT_DOC_BASE_URL, openExternal } from '../src/core/hmi/help-url';
import { HELP_FALLBACK } from '../src/core/hmi/help-topics';
import { openCurrentHelp } from '../src/core/hmi/help-context';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { setAppConfig } from '../src/core/rv-app-config';

afterEach(() => {
  setAppConfig({});
  vi.restoreAllMocks();
});

describe('buildHelpUrl', () => {
  it('builds a page URL with a trailing slash', () => {
    expect(buildHelpUrl({ slug: 'des/overview' }))
      .toBe('https://realvirtual.io/doc/web/des/overview/');
  });

  it('appends an anchor when present', () => {
    expect(buildHelpUrl({ slug: 'planner/overview', anchor: 'snapping' }))
      .toBe('https://realvirtual.io/doc/web/planner/overview/#snapping');
  });

  it('returns the documentation root for the fallback topic', () => {
    expect(buildHelpUrl(HELP_FALLBACK)).toBe(DEFAULT_DOC_BASE_URL);
    expect(DEFAULT_DOC_BASE_URL).toBe('https://realvirtual.io/doc/web/');
  });

  it('honours a configured base URL without doubling slashes', () => {
    expect(buildHelpUrl({ slug: 'odt' }, 'https://kunde.example/hilfe/'))
      .toBe('https://kunde.example/hilfe/odt/');
  });

  it('adds the missing separator when the base URL has none', () => {
    expect(buildHelpUrl({ slug: 'odt' }, 'https://kunde.example/hilfe'))
      .toBe('https://kunde.example/hilfe/odt/');
  });

  it.each([[''], ['   '], ['javascript:alert(1)'], ['ftp://x/y'], ['not a url']])(
    'ignores the invalid base URL %p and uses the default', (bad) => {
      expect(buildHelpUrl({ slug: 'odt' }, bad))
        .toBe('https://realvirtual.io/doc/web/odt/');
    });

  it.each([[null], [undefined]])('ignores %p and uses the default', (bad) => {
    expect(buildHelpUrl({ slug: 'odt' }, bad as unknown as string))
      .toBe('https://realvirtual.io/doc/web/odt/');
  });
});

describe('openExternal', () => {
  it('opens in a new tab with the opener severed', () => {
    const spy = vi.spyOn(window, 'open').mockImplementation(() => null);
    openExternal('https://realvirtual.io/doc/web/');
    expect(spy).toHaveBeenCalledWith(
      'https://realvirtual.io/doc/web/', '_blank', 'noopener,noreferrer',
    );
  });
});

// F6 — the shared helper itself. The two handler paths get their own tests in
// help-shortcut.test.tsx and help-activity-bar.test.tsx.
describe('openCurrentHelp', () => {
  function viewerWith(panel: string | null) {
    const leftPanelManager = new LeftPanelManager();
    if (panel) leftPanelManager.open(panel, 300, 'left');
    return { leftPanelManager, modes: { activeMode: null } };
  }

  it('uses the configured base URL', () => {
    setAppConfig({ docs: { baseUrl: 'https://kunde.example/hilfe/' } });
    const spy = vi.spyOn(window, 'open').mockImplementation(() => null);
    openCurrentHelp(viewerWith('connect'));
    expect(spy).toHaveBeenCalledWith(
      'https://kunde.example/hilfe/connect/overview/', '_blank', 'noopener,noreferrer',
    );
  });

  it('falls back to the documentation root without any context', () => {
    const spy = vi.spyOn(window, 'open').mockImplementation(() => null);
    openCurrentHelp(viewerWith(null));
    expect(spy).toHaveBeenCalledWith(
      'https://realvirtual.io/doc/web/', '_blank', 'noopener,noreferrer',
    );
  });

  it('survives a viewer without the managers instead of throwing', () => {
    const spy = vi.spyOn(window, 'open').mockImplementation(() => null);
    openCurrentHelp({});
    expect(spy).toHaveBeenCalledWith(
      'https://realvirtual.io/doc/web/', '_blank', 'noopener,noreferrer',
    );
  });
});
