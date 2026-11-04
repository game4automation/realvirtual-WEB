// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { downloadTextFile } = vi.hoisted(() => ({ downloadTextFile: vi.fn() }));
vi.mock('../src/core/hmi/rv-download-text-file', () => ({ downloadTextFile }));

import { diagnosticsCollector } from '../src/core/diagnostics/rv-diagnostics-collector';
import { exportDiagnostics } from '../src/core/diagnostics/rv-diagnostics-export';
import { resetDiagnosticsConnectOriginForTests } from '../src/core/diagnostics/rv-diagnostics-streamer';

beforeEach(() => {
  diagnosticsCollector.clear(); downloadTextFile.mockClear(); vi.restoreAllMocks();
  resetDiagnosticsConnectOriginForTests(false);
});

describe('exportDiagnostics', () => {
  it('fetches and downloads the CONNECT bundle', async () => {
    resetDiagnosticsConnectOriginForTests(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['zip']), {
      status: 200, headers: { 'Content-Disposition': 'attachment; filename="rv-diagnostics-connect.zip"' },
    })));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const result = await exportDiagnostics({ minutes: 15 });
    expect(result).toEqual({ ok: true, file: 'rv-diagnostics-connect.zip', source: 'connect' });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/diag/bundle?minutes=15&clientTime='));
    expect(click).toHaveBeenCalled();
  });

  it('falls back to JSON containing environment and entries', async () => {
    diagnosticsCollector.add({ lvl: 'error', cat: 'window', msg: 'marker' });
    const result = await exportDiagnostics({ minutes: 15 });
    expect(result.source).toBe('browser');
    const payload = JSON.parse(downloadTextFile.mock.calls[0][0]);
    expect(payload.environment.web.tabs).toHaveLength(1);
    expect(payload.entries[0].msg).toBe('marker');
  });
});
