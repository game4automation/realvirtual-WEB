// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * FileDropZone — the "I just downloaded a part from a catalog" path in the
 * Unified Import Dialog.
 *
 * What these tests pin is the behaviour that would quietly rot:
 *
 *  - **Extension filtering is lossy on purpose.** A datasheet dragged along
 *    with the geometry is discarded rather than failing the whole import —
 *    but the discard is reported, never silent.
 *  - **The highlight uses a DEPTH COUNTER, not a boolean.** Every child
 *    element fires its own dragenter/dragleave pair, so a boolean flickers as
 *    the pointer crosses the inner text. The nested-enter test is the
 *    regression guard for that.
 *
 * The `PartSourceLinks` suite that used to live here is GONE with the
 * component (plan-444 F1, LOP-124): the import tabs no longer point at
 * 3Dfindit / TraceParts at all. The export test below is what keeps the
 * removal from being undone by a merge.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import * as importUi from '../src/plugins/unified-import/import-ui';
import { FileDropZone, matchesAccept } from '../src/plugins/unified-import/import-ui';

afterEach(() => cleanup());

/**
 * Fire a drag event carrying real files.
 *
 * Two Chromium facts these tests had to be built around — both cost an hour
 * once, so they are written down rather than rediscovered:
 *
 *  1. `fireEvent.drop(el, { dataTransfer })` does NOT work here. A plain-object
 *     stand-in makes `new DragEvent()` throw outright, and even a real
 *     `DataTransfer` passed as init arrives with an EMPTY `files` list. The
 *     event must be constructed first and handed to `fireEvent(el, ev)`, which
 *     dispatches it as-is (and still wraps the React update in `act`).
 *  2. `dataTransfer.dropEffect` is not observable from a test. Chromium keeps
 *     it read-only outside a genuine user drag, so it stays `'none'` however
 *     the handler sets it. The component sets it because real drags need it;
 *     asserting on it here would only pin browser behaviour, so don't re-add
 *     that test.
 */
function fireDrag(el: Element, type: 'dragenter' | 'dragleave' | 'dragover' | 'drop', files: File[] = []) {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  fireEvent(el, new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
}

function file(name: string, bytes = 4): File {
  return new File([new Uint8Array(bytes)], name);
}

describe('matchesAccept', () => {
  it('matches case-insensitively on the extension', () => {
    expect(matchesAccept('Cylinder.GLB', ['.glb'])).toBe(true);
    expect(matchesAccept('cylinder.glb', ['.glb'])).toBe(true);
  });

  it('accepts any of several extensions', () => {
    expect(matchesAccept('part.stp', ['.step', '.stp'])).toBe(true);
    expect(matchesAccept('part.step', ['.step', '.stp'])).toBe(true);
  });

  it('rejects a non-matching extension', () => {
    expect(matchesAccept('datasheet.pdf', ['.step', '.stp'])).toBe(false);
  });

  it('does not match an extension appearing mid-name', () => {
    expect(matchesAccept('glb-notes.txt', ['.glb'])).toBe(false);
  });
});

describe('FileDropZone', () => {
  it('passes accepted files on and drops the rest, reporting the loss', () => {
    const onFiles = vi.fn();
    render(<FileDropZone accept={['.glb']} onFiles={onFiles} />);
    const zone = screen.getByTestId('import-drop-zone');

    fireDrag(zone, 'drop', [file('a.glb'), file('sheet.pdf')]);

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['a.glb']);
    // The discard is stated, so nothing goes missing silently.
    expect(screen.getByText(/1 file ignored/)).toBeTruthy();
  });

  it('does not call onFiles when nothing matched', () => {
    const onFiles = vi.fn();
    render(<FileDropZone accept={['.glb']} onFiles={onFiles} />);

    fireDrag(screen.getByTestId('import-drop-zone'), 'drop', [file('sheet.pdf')]);

    expect(onFiles).not.toHaveBeenCalled();
    expect(screen.getByText(/1 file ignored/)).toBeTruthy();
  });

  it('honours multiple=false by taking only the first accepted file', () => {
    const onFiles = vi.fn();
    render(<FileDropZone accept={['.glb']} multiple={false} onFiles={onFiles} />);

    fireDrag(screen.getByTestId('import-drop-zone'), 'drop', [file('a.glb'), file('b.glb')]);

    expect(onFiles.mock.calls[0][0].map((f: File) => f.name)).toEqual(['a.glb']);
  });

  it('keeps the highlight while a nested leave fires inside an active drag', () => {
    render(<FileDropZone accept={['.glb']} onFiles={vi.fn()} />);
    const zone = screen.getByTestId('import-drop-zone');
    expect(zone.getAttribute('data-dragover')).toBe('false');

    // Pointer enters the zone, then the inner text: two enters, one leave.
    fireDrag(zone, 'dragenter');
    fireDrag(zone, 'dragenter');
    fireDrag(zone, 'dragleave');
    expect(zone.getAttribute('data-dragover')).toBe('true');

    // The matching outer leave ends the drag and clears the highlight.
    fireDrag(zone, 'dragleave');
    expect(zone.getAttribute('data-dragover')).toBe('false');
  });

  it('clears the highlight on drop, so a second drag starts clean', () => {
    render(<FileDropZone accept={['.glb']} onFiles={vi.fn()} />);
    const zone = screen.getByTestId('import-drop-zone');

    fireDrag(zone, 'dragenter');
    fireDrag(zone, 'drop', [file('a.glb')]);

    expect(zone.getAttribute('data-dragover')).toBe('false');
  });
});

describe('catalog links (removed, plan-444 F1)', () => {
  it('exports no PartSourceLinks component any more', () => {
    expect('PartSourceLinks' in importUi).toBe(false);
  });
});
