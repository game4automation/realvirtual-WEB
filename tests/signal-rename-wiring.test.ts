// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-590 Phase 5 — the coordinator's wiring into the documents the viewer opens.
 *
 *  - an asset document becomes intercepted the moment the editor OPENS it (not only when a rename
 *    writes to it): a tagged entry without a journal — a rename from a reloaded session — is then
 *    refused instead of being undone model-only, and the stacks stay where they were;
 *  - the refusal is said as a toast, read from `RvDocument.lastHistoryInterception`;
 *  - the environment follows the mode: the asset document in the editor (no overlay), the scene
 *    store elsewhere;
 *  - the dry-run preview is serialisable and carries no step payload.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { RVViewer } from '../src/core/rv-viewer';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { setActiveAssetContext, type ActiveAssetContext } from '../src/core/editor/active-asset-store';
import {
  getInstructions,
  _resetStoreForTests as resetInstructions,
} from '../src/core/hmi/instruction-store';
import {
  installSignalRenameWiring,
  signalRenameCoordinatorFor,
  signalRenameEnvironmentFor,
  summarizeSignalRenamePlan,
  SIGNAL_RENAME_REFUSED_TOAST_ID,
} from '../src/core/hmi/signal-rename-wiring';
import { field, head, makeRenameFixture, node, plc, planIn, type RenameFixture } from './helpers/signal-rename-fixture';

const uninstall: Array<() => void> = [];

afterEach(() => {
  for (const u of uninstall.splice(0)) u();
  setActiveAssetContext(null);
  resetInstructions();
});

function build(): RenameFixture {
  return makeRenameFixture((root) => {
    node('Start', root, plc('PLCInputBool', 'DB.Start'));
    node('Sensor', root, { WebSensor: { SignalBool: 'DB.Start' } });
  }, { connectNames: ['DB.Start'] });
}

/** The editor opens `f.asset` (structural AssetDocument: `document` + `setFieldAwaited`). */
function openInEditor(f: RenameFixture): void {
  const assetDoc = {
    document: f.asset,
    setFieldAwaited: (p: string, c: string, n: string, v: unknown, prev: unknown) =>
      f.asset.applyOp({ ...head(), kind: 'setField', nodePath: p, componentType: c, fieldName: n, value: v, prev } as RvOp),
  };
  setActiveAssetContext({ viewer: f.viewer, doc: assetDoc } as unknown as ActiveAssetContext);
}

/** A tagged rename entry as a reloaded session finds it: in the log, but no journal for it. */
async function orphanTaggedEntry(f: RenameFixture): Promise<void> {
  await f.asset.withTransaction('Rename signal DB.Start → DB.Go', async () => {
    await f.asset.applyOp({
      ...head(), kind: 'setField', nodePath: 'Asset/Start', componentType: 'PLCInputBool',
      fieldName: 'Name', value: 'DB.Go', prev: 'DB.Start',
    } as RvOp);
  }, { meta: { journalId: 'sr_from_last_session' } });
}

describe('plan-590 — signal-rename wiring', () => {
  it('intercepts an asset document from the moment it is opened; an orphaned tagged entry is refused with a toast', async () => {
    const f = build();
    uninstall.push(installSignalRenameWiring(f.viewer));
    openInEditor(f);
    expect(f.asset.historyInterceptor).not.toBeNull();

    await orphanTaggedEntry(f);
    expect(field(f, 'Asset/Start', 'PLCInputBool', 'Name')).toBe('DB.Go');
    const before = f.asset.historyHead();

    await f.asset.undo();
    // Refused: the model part alone is NOT undone, the stacks did not move.
    expect(f.asset.lastHistoryInterception).toEqual({ journalId: 'sr_from_last_session', direction: 'undo', verdict: 'refused' });
    expect(field(f, 'Asset/Start', 'PLCInputBool', 'Name')).toBe('DB.Go');
    expect(f.asset.historyHead()).toEqual(before);

    const toast = getInstructions().find((i) => i.id === SIGNAL_RENAME_REFUSED_TOAST_ID);
    expect(toast?.style).toBe('toast');
    expect(toast?.text).toContain('earlier session');
  });

  it('a normal undo next to it is untouched and shows no toast', async () => {
    const f = build();
    uninstall.push(installSignalRenameWiring(f.viewer));
    openInEditor(f);
    await f.asset.applyOp({
      ...head(), kind: 'setField', nodePath: 'Asset/Sensor', componentType: 'WebSensor', fieldName: 'Label', value: 'L', prev: undefined,
    } as RvOp);
    await f.asset.undo();
    expect(field(f, 'Asset/Sensor', 'WebSensor', 'Label')).toBeUndefined();
    expect(getInstructions().some((i) => i.id === SIGNAL_RENAME_REFUSED_TOAST_ID)).toBe(false);
  });

  it('the environment follows the mode: asset document in the editor (no overlay)', () => {
    const f = build();
    openInEditor(f);
    const editorViewer = Object.assign(Object.create(f.viewer as object), { modes: { activeMode: 'editor' } }) as RVViewer;
    const env = signalRenameEnvironmentFor(editorViewer);
    expect(env.docs.model?.kind).toBe('asset-doc');
    expect(env.docs.model?.document).toBe(f.asset);
    expect(env.docs.overlay).toBeNull();

    const sceneViewer = Object.assign(Object.create(f.viewer as object), { modes: { activeMode: 'viewer' } }) as RVViewer;
    const sceneEnv = signalRenameEnvironmentFor(sceneViewer);
    // No scene store in this harness → no model document outside the editor (never the asset doc).
    expect(sceneEnv.docs.model?.document ?? null).not.toBe(f.asset);
  });

  it('one coordinator per viewer, whoever asks first', () => {
    const f = build();
    expect(signalRenameCoordinatorFor(f.viewer)).toBe(signalRenameCoordinatorFor(f.viewer));
  });

  it('the preview is serialisable and leaves the step payloads out', async () => {
    const f = build();
    const plan = await planIn(f, 'Asset/Start', 'DB.Go');
    const preview = summarizeSignalRenamePlan(plan);
    expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
    expect(preview.steps.length).toBe(plan.steps.length);
    for (const s of preview.steps) {
      expect(s).not.toHaveProperty('value');
      expect(s).not.toHaveProperty('prev');
    }
    expect(preview).toMatchObject({ oldName: 'DB.Start', newName: 'DB.Go', ok: true, scope: plan.scope });
  });
});
