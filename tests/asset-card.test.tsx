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
import { AssetCard, fileGlyphOf, isCadExtension } from '../src/core/library/AssetCard';
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

describe('AssetCard file glyphs (dashboard project files)', () => {
  it('labels the knowledge tile MD, not Knowledge', () => {
    render(<AssetCard entry={entry()} glyph="knowledge" />);
    expect(screen.getByText('MD')).toBeTruthy();
    expect(screen.queryByText('Knowledge')).toBeNull();
  });

  it('labels a file tile with its extension in capitals, and a bare file "File"', () => {
    expect(fileGlyphOf('docs/Manual.PDF')).toBe('file:pdf');
    expect(fileGlyphOf('deck.pptx')).toBe('file:pptx');
    expect(fileGlyphOf('README')).toBe('file:');
    render(<AssetCard entry={entry()} glyph={fileGlyphOf('docs/Manual.PDF')} />);
    // The tile uppercases via CSS; the text node is the raw extension.
    expect(screen.getByText('pdf')).toBeTruthy();
    // A media file is neutral grey — neither magenta (MD) nor amber (CAD).
    const pdfColor = getComputedStyle(screen.getByText('pdf')).color;
    expect(pdfColor).toContain('255, 255, 255');
    expect(pdfColor).not.toContain('233, 64, 120');
    cleanup();
    render(<AssetCard entry={entry()} glyph="file:" />);
    expect(screen.getByText('File')).toBeTruthy();
  });
});

describe('AssetCard CAD glyph', () => {
  it('knows the CAD formats by extension, case-insensitively', () => {
    for (const ext of ['step', 'STP', 'iges', 'jt', 'stl', 'obj', 'fbx', 'dxf', 'sldprt']) {
      expect(isCadExtension(ext), ext).toBe(true);
    }
    expect(isCadExtension('pdf')).toBe(false);
    expect(isCadExtension('md')).toBe(false);
  });

  it('renders a CAD file with the extension label and the CAD accent, not the document one', () => {
    const { container } = render(<AssetCard entry={entry()} glyph={fileGlyphOf('cad/Frame.STEP')} />);
    expect(screen.getByText('step')).toBeTruthy();
    expect(container.querySelector('[data-testid="CategoryOutlinedIcon"]')).toBeTruthy();
    // Only the label and icon carry the accent — amber for CAD, never magenta;
    // the tile behind them stays the neutral grey of every other placeholder.
    const label = screen.getByText('step');
    const labelColor = getComputedStyle(label).color;
    expect(labelColor).toContain('255, 167, 38');
    expect(labelColor).not.toContain('233, 64, 120');
    const tile = getComputedStyle(label.parentElement!);
    expect(tile.borderColor).not.toContain('255, 167, 38');
    expect(tile.backgroundColor).toContain('255, 255, 255');
  });
});
