// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AssetCard — the single library card generalised out of ThumbnailCard
 * (plan-372 Phase 6, tests §9.18).
 *
 * The point of the extraction was that the planner panel and the Projects
 * dashboard show one card, not two that drift. These tests pin the parts a
 * drift would show up in first: the four preview states, the bundled tier
 * badge, and that drag stays the caller's business (handlers pass through
 * untouched, `draggable` is honoured).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { AssetCard } from '../src/core/library/AssetCard';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';

afterEach(() => cleanup());

function entry(over: Partial<LibraryCatalogEntry> = {}): LibraryCatalogEntry {
  return { id: 'a1', name: 'Belt 1000', category: 'conveyor', ...over };
}

describe('AssetCard preview states', () => {
  it('renders the thumbnail image when the entry has one', () => {
    render(<AssetCard entry={entry({ thumbnailUrl: 'blob:preview' })} />);
    const img = screen.getByAltText('Belt 1000') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('blob:preview');
    // The image must never be natively draggable — it would hijack the card drag.
    expect(img.getAttribute('draggable')).toBe('false');
  });

  it('renders the virtual glyph with the DES type stripped of its prefix', () => {
    render(<AssetCard entry={entry({ virtual: true, desType: 'DESStation' })} />);
    expect(screen.getByText('Station')).toBeTruthy();
  });

  it('renders the splat glyph for splat entries', () => {
    render(<AssetCard entry={entry({ splatUrl: 'x.splat' })} />);
    expect(screen.getByText('Splat')).toBeTruthy();
  });

  it('renders the caller-supplied placeholder action when there is no preview', () => {
    render(<AssetCard entry={entry()} placeholderAction={<button>gen</button>} />);
    expect(screen.getByRole('button', { name: 'gen' })).toBeTruthy();
  });
});

describe('AssetCard tier badge', () => {
  it('badges bundled entries', () => {
    render(<AssetCard entry={entry()} tier="bundled" />);
    expect(screen.getByText('Bundled')).toBeTruthy();
  });

  it('shows no badge for user-tier or unspecified entries', () => {
    render(<AssetCard entry={entry()} tier="user" />);
    expect(screen.queryByText('Bundled')).toBeNull();
    cleanup();
    render(<AssetCard entry={entry()} />);
    expect(screen.queryByText('Bundled')).toBeNull();
  });
});

describe('AssetCard behaviour stays with the caller', () => {
  it('honours draggable and forwards drag handlers unchanged', () => {
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();
    render(
      <AssetCard entry={entry()} draggable onDragStart={onDragStart} onDragEnd={onDragEnd} />,
    );
    const card = screen.getByText('Belt 1000').parentElement!;
    expect(card.getAttribute('draggable')).toBe('true');
    fireEvent.dragStart(card);
    fireEvent.dragEnd(card);
    expect(onDragStart).toHaveBeenCalledTimes(1);
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  it('is not draggable unless asked, and still forwards click / context menu', () => {
    const onClick = vi.fn();
    const onContextMenu = vi.fn();
    render(<AssetCard entry={entry()} onClick={onClick} onContextMenu={onContextMenu} />);
    const card = screen.getByText('Belt 1000').parentElement!;
    expect(card.getAttribute('draggable')).toBe('false');
    fireEvent.click(card);
    fireEvent.contextMenu(card);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });

  it('renders tags supplied by the entry', () => {
    render(<AssetCard entry={entry({ tags: ['fast', 'belt'] })} />);
    expect(screen.getByText('fast')).toBeTruthy();
    expect(screen.getByText('belt')).toBeTruthy();
  });
});
