// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-702 §9.7 — the planner library panel is a BROWSER, not a manager.
 *
 * Two directions, and the second one matters more than the first. Removing the
 * add/remove/edit affordances is the visible half; keeping "Refresh folder"
 * and the re-grant button is a BINDING user decision, and the review found a
 * delete range (`:796-808`) that would have taken "Refresh folder" with it
 * (R1). These tests exist so that mistake cannot be made silently.
 *
 * `LibrarySelector` is mounted for real — it is presentational and needs no
 * viewer. The panel itself has no mount precedent in this suite and would need
 * the viewer, the plugin registry, the layout store and the cloud store
 * stubbed, so its half is asserted against its source text, the same technique
 * `bundle-splitting.test.ts` uses for its chunk markers.
 */
import { describe, test, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { LibrarySelector, type LibraryItem } from '../src/plugins/layout-planner/LibrarySelector';
import panelSource from '../src/plugins/layout-planner/LayoutLibraryPanel.tsx?raw';
import selectorSource from '../src/plugins/layout-planner/LibrarySelector.tsx?raw';

afterEach(() => cleanup());

const LOCAL_ITEM: LibraryItem = { id: 'local:Work/library', label: 'Work/library', kind: 'local' };

function renderSelector(over: Partial<React.ComponentProps<typeof LibrarySelector>> = {}) {
  const onManage = vi.fn();
  const onRefresh = vi.fn();
  const utils = render(
    <LibrarySelector
      items={[LOCAL_ITEM]}
      activeId={LOCAL_ITEM.id}
      onSelect={() => {}}
      onRefresh={onRefresh}
      onManage={onManage}
      {...over}
    />,
  );
  return { ...utils, onManage, onRefresh };
}

describe('LibrarySelector after the plan-702 slimming', () => {
  test('no longer renders add/remove/edit-connection affordances', () => {
    renderSelector();
    fireEvent.click(screen.getByRole('button', { name: /Work\/library/ }));

    expect(screen.queryByLabelText('Remove library')).toBeNull();
    expect(screen.queryByLabelText('Add library')).toBeNull();
    expect(screen.queryByText('Add library…')).toBeNull();
    expect(screen.queryByText('Remove library')).toBeNull();
    expect(screen.queryByText('Edit Connection')).toBeNull();
  });

  test('STILL offers "Refresh folder" for a local folder library', () => {
    const { onRefresh } = renderSelector();
    const refresh = screen.getByLabelText('Refresh folder');
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledWith(LOCAL_ITEM.id);
  });

  test('offers exactly one management route: Manage libraries…', () => {
    const { onManage } = renderSelector();
    fireEvent.click(screen.getByRole('button', { name: /Work\/library/ }));

    const entries = screen.getAllByText('Manage libraries…');
    expect(entries).toHaveLength(1);
    fireEvent.click(entries[0]);
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  test('an empty library list sends the trigger straight to management', () => {
    const { onManage } = renderSelector({ items: [], activeId: null });
    fireEvent.click(screen.getByRole('button', { name: /Add a library/ }));
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});

describe('LayoutLibraryPanel source contract', () => {
  test('the management dialogs and their handlers are gone', () => {
    for (const marker of [
      'Edit Connection',
      'handleAddCatalog',
      'handleAddGitHub',
      'handleAddAssetManager',
      'handleAddLocalFolder',
      'handleEditAmConnection',
      'handleSaveAmEdit',
      'handleRemoveLibrary',
      'setAddUrlOpen',
      // The dead private escape hatch (removed from the private repo in
      // plan-372 Phase 13). The bare identifier survives in a comment that
      // records WHY it went, so the marker is the render site itself.
      'extension?.cloudTabComponent',
      'onEdit=',
    ]) {
      expect(panelSource, `"${marker}" should be gone from the panel`)
        .not.toContain(marker);
    }
    expect(selectorSource).not.toContain('onRemove');
    expect(selectorSource).not.toContain('onAdd');
  });

  test('the BROWSING affordances the user decided to keep are still there', () => {
    // The binding decision from the grill phase: refresh and re-grant are what
    // browsing a local folder needs, so they stay in the planner (R1).
    expect(panelSource).toContain('handleRefreshLocalFolder');
    expect(panelSource).toContain('Refresh folder');
    expect(panelSource).toContain('Re-grant access');
    expect(panelSource).toContain('activateLocalFolder');
    expect(panelSource).toContain('LOCAL_NEEDS_PERMISSION');
    expect(panelSource).toContain('libraryItems');
  });

  test('the panel keeps exactly one management route', () => {
    expect(panelSource).toContain('handleManageLibraries');
    expect(panelSource.match(/globalLibraries/g) ?? []).toHaveLength(1);
    // Count the CALL, not the label: the empty state names "Manage libraries…"
    // in prose to point the user at it, which is a mention, not a second route.
    expect(panelSource.match(/openProjectsDashboard\(/g) ?? []).toHaveLength(1);
  });
});
