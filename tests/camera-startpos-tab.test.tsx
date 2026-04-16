// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Vector3 } from 'three';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CameraStartTab } from '../src/core/hmi/settings/CameraStartTab';
import { saveStartPos } from '../src/core/hmi/camera-startpos-store';

function mockViewer(url: string | null = '/models/TabTest.glb') {
  const listeners = new Map<string, Set<(d?: unknown) => void>>();
  return {
    pendingModelUrl: url, currentModelUrl: url,
    camera: { position: new Vector3(5, 6, 7) },
    controls: { target: new Vector3(0, 1, 0) },
    scene: { children: [] },
    on: (ev: string, cb: (d?: unknown) => void) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(cb);
      return () => listeners.get(ev)?.delete(cb);
    },
  } as any;
}

describe('CameraStartTab', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows "No model loaded" when no URL', () => {
    render(<CameraStartTab viewer={mockViewer(null)} />);
    expect(screen.getByText(/No model loaded/i)).toBeTruthy();
  });

  it('shows "No start view" initial state', () => {
    render(<CameraStartTab viewer={mockViewer()} />);
    expect(screen.getByText(/No start view/i)).toBeTruthy();
  });

  it('disables Save button when no model', () => {
    render(<CameraStartTab viewer={mockViewer(null)} />);
    const btn = screen.getByRole('button', { name: /Save current camera/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Save persists preset + success toast + UI updates WITHOUT reload (same-tab)', () => {
    render(<CameraStartTab viewer={mockViewer()} />);
    fireEvent.click(screen.getByRole('button', { name: /Save current camera/i }));
    expect(localStorage.getItem('rv-camera-start:TabTest')).toBeTruthy();
    expect(screen.getByText(/Start view saved/i)).toBeTruthy();
    // Critical regression test: status must show "Saved (user)" immediately (not "No start view")
    expect(screen.getByText(/Saved \(user\)/i)).toBeTruthy();
  });

  it('Save shows error toast on quota exceeded', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    render(<CameraStartTab viewer={mockViewer()} />);
    fireEvent.click(screen.getByRole('button', { name: /Save current camera/i }));
    expect(screen.getByText(/Save failed/i)).toBeTruthy();
  });

  it('Clear button disabled without preset', () => {
    render(<CameraStartTab viewer={mockViewer()} />);
    const btn = screen.getByRole('button', { name: /Clear start view/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Clear button disabled when source is author (GLB default)', () => {
    saveStartPos('TabTest', { px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0, source: 'author' });
    render(<CameraStartTab viewer={mockViewer()} />);
    const btn = screen.getByRole('button', { name: /Clear start view/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('Clear removes preset + toast', () => {
    saveStartPos('TabTest', { px: 1, py: 0, pz: 0, tx: 0, ty: 1, tz: 0, source: 'user' });
    render(<CameraStartTab viewer={mockViewer()} />);
    fireEvent.click(screen.getByRole('button', { name: /Clear start view/i }));
    expect(localStorage.getItem('rv-camera-start:TabTest')).toBeNull();
    expect(screen.getByText(/Start view cleared/i)).toBeTruthy();
  });
});
