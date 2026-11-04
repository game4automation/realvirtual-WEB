// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { RVViewer } from '../../src/core/rv-viewer';
import { DESSnapshotMenu, DESSnapshotFeedback } from '../../src/plugins/des/hmi/des-hmi-plugin';
import { clear } from '../../src/plugins/des/hmi/des-snapshot-feedback-store';
import { snapshotRefusalText } from '../../src/core/sdk/rv-des-snapshot-messages';
vi.mock('../../src/core/hmi/ToolFlyout', () => ({
  ToolFlyout: ({ children }: any) => <div>{children}</div>,
  ToolFlyoutRow: ({ onSelect, testId }: any) => <button data-testid={testId} onClick={onSelect} />,
}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
for (const action of ['save', 'load']) for (const refusal of [false, true]) {
  it(`${action}: ${refusal ? 'refusal' : 'success'} is visible`, async () => {
    const error = { code: 'des-snapshot-fingerprint' };
    const operation = vi.fn(() => { if (refusal) throw error; return '{}'; });
    const viewer = { on: () => () => {}, simulationKernel: { desControl: () => ({ snapshotJson: operation, restoreJson: operation }) } } as unknown as RVViewer;
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    const create = document.createElement.bind(document);
    let picker: HTMLInputElement | undefined;
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: any) => {
      const element = create(tag, options);
      if (tag === 'input') {
        picker = element as HTMLInputElement;
        Object.defineProperty(picker, 'files', { value: [{ text: async () => '{}' }] });
        picker.click = () => {};
      }
      if (tag === 'a') element.click = () => {};
      return element;
    }) as typeof document.createElement);
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} });
    try {
      await act(async () => { root.render(<><DESSnapshotMenu viewer={viewer} /><DESSnapshotFeedback /></>); });
      await act(async () => { (host.querySelector(`[data-testid="des-side-snapshot-${action}"]`) as HTMLElement).click(); });
      if (action === 'load') await act(async () => { await picker!.onchange!(new Event('change')); });
      expect(host.querySelector('[data-testid="des-snapshot-feedback"]')?.textContent).toBe(refusal ? snapshotRefusalText(error) : action === 'save' ? 'Snapshot saved.' : 'Snapshot loaded.');
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
}
