// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-513 §9.8 — the mode chip, and every surface that shows it.
 *
 * The chip names the mode a click will open the document in: a registered
 * mode shows its label, an unknown mode or none shows nothing. The surfaces —
 * the model search, the cards, the recents — show what their caller RESOLVED
 * (the host's `effectiveOpenMode`), never a mode of their own; in particular
 * the recents no longer read the ring's `mode` when the host resolves one.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DocumentModeChip } from '../src/core/hmi/projects/DocumentModeChip';
import { ModelSearchResults } from '../src/core/hmi/projects/ModelSearchResults';
import { ProjectFolderContents, type FolderCardModel } from '../src/core/hmi/projects/ProjectFolderContents';
import { RecentDocumentsSection } from '../src/core/hmi/projects/RecentDocumentsSection';
import {
  buildModelSearchIndex, capModelSearch, searchModelIndex,
} from '../src/core/project/rv-model-search';
import { MODEL_INDEX_SCHEMA_VERSION, type ModelIndexSnapshot } from '../src/core/project/rv-model-index';
import type { RecentDocumentEntry } from '../src/core/project/rv-project-recents';

afterEach(() => cleanup());

const LABELS: Record<string, string> = { hmi: 'HMI', planner: 'Planner', editor: 'Editor' };
const modeLabel = (m: string) => LABELS[m];

describe('DocumentModeChip', () => {
  it('a registered mode shows its label', () => {
    render(<DocumentModeChip mode="editor" modeLabel={modeLabel} testId="chip" />);
    expect(screen.getByTestId('chip').textContent).toBe('Editor');
  });

  it('an unknown mode, null and undefined render nothing', () => {
    const { container } = render(
      <>
        <DocumentModeChip mode="gone" modeLabel={modeLabel} testId="a" />
        <DocumentModeChip mode={null} modeLabel={modeLabel} testId="b" />
        <DocumentModeChip mode={undefined} modeLabel={modeLabel} testId="c" />
      </>,
    );
    expect(container.textContent).toBe('');
    expect(screen.queryByTestId('a')).toBeNull();
  });
});

describe('the surfaces show the resolved target', () => {
  it('model search: each hit shows what modeOf resolves', () => {
    const snaps: ModelIndexSnapshot[] = [{
      version: MODEL_INDEX_SCHEMA_VERSION, projectId: 'p', projectName: 'P', backend: 'folder' as const,
      updatedAt: '', docs: [
        { id: 'd1', name: 'Line one', path: 'line1.glb', tags: [], mode: 'hmi' },
        { id: 'd2', name: 'Line two', path: 'line2.glb', tags: [] },
      ],
    }];
    const result = capModelSearch(searchModelIndex(
      buildModelSearchIndex(snaps, [{ key: 'folder:p', name: 'P' }]), 'line'));
    // The host's rule, stood in: d1 has a stored `editor`, d2 has nothing.
    const modeOf = (hit: { entry: { doc: { id: string; mode?: string } } }) =>
      (hit.entry.doc.id === 'd1' ? 'editor' : hit.entry.doc.mode ?? null);
    render(<ModelSearchResults result={result} modeOf={modeOf} modeLabel={modeLabel} onActivate={() => {}} />);
    expect(screen.getByTestId('model-search-mode-folder:p/d1').textContent).toBe('Editor');
    expect(screen.queryByTestId('model-search-mode-folder:p/d2')).toBeNull();
  });

  it('cards: a card with an openMode shows it, one without shows nothing', () => {
    const card = (key: string, openMode: string | null): FolderCardModel => ({
      key,
      entry: { id: key, name: key, category: 'custom' },
      tier: 'user',
      selected: false,
      onSelect: () => {},
      openMode,
    });
    render(
      <ProjectFolderContents
        cards={[card('a.glb', 'planner'), card('b.glb', null)]}
        modeLabel={modeLabel}
      />,
    );
    expect(screen.getByTestId('card-mode-a.glb').textContent).toBe('Planner');
    expect(screen.queryByTestId('card-mode-b.glb')).toBeNull();
  });

  it('recents: the resolved mode wins over the ring\'s own mode', () => {
    const entry = (documentId: string, mode?: string): RecentDocumentEntry => ({
      projectId: 'P', backend: 'folder', documentId, documentName: documentId,
      documentPath: `${documentId}.glb`, projectName: 'P', mode, openedAt: '',
    });
    render(
      <RecentDocumentsSection
        entries={[entry('a', 'hmi'), entry('b', 'planner')]}
        rowStates={new Map()}
        modeLabel={modeLabel}
        // a: the store says editor. b: the store knows nothing and no declared mode.
        modeOf={(e) => (e.documentId === 'a' ? 'editor' : null)}
        busy={false}
        onOpen={() => {}}
        onForget={() => {}}
        onClear={() => {}}
      />,
    );
    expect(screen.getByTestId('recent-mode-a').textContent).toBe('Editor');
    expect(screen.queryByTestId('recent-mode-b')).toBeNull();
  });
});
