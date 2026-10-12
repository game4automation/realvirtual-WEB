// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-590 §2.1 0b / SOL R2 #8 — "mehrere Modellbesitzer".
 *
 * plan-589 keeps authored names RAW, so two authored nodes may register the
 * same name. Renaming "the" signal would then rename one node's extras while
 * the store name still has a second owner — the rename is refused with both
 * paths, in the plan AND (re-checked) at apply time.
 */

import { describe, expect, it } from 'vitest';
import { makeRenameFixture, node, plc, planIn } from './helpers/signal-rename-fixture';

const build = () => makeRenameFixture((root) => {
  const a = node('LineA', root);
  const b = node('LineB', root);
  node('Start', a, plc('PLCInputBool', 'Dup'));
  node('Start', b, plc('PLCInputBool', 'Dup'));
  node('Single', root, plc('PLCInputBool', 'Single'));
});

describe('signal rename — several model owners', () => {
  it('two authored nodes with the same name → blocker naming both paths', async () => {
    const f = build();
    const plan = await planIn(f, 'Asset/LineA/Start', 'Renamed');
    expect(plan.owners.sort()).toEqual(['Asset/LineA/Start', 'Asset/LineB/Start']);
    expect(plan.ok).toBe(false);
    const blocker = plan.blockers.find((b) => b.includes('2 model nodes'));
    expect(blocker).toBeDefined();
    expect(blocker).toContain('Asset/LineA/Start');
    expect(blocker).toContain('Asset/LineB/Start');
  });

  it('the apply re-checks the owners (a duplicate created after planning)', async () => {
    const f = build();
    const plan = await planIn(f, 'Asset/Single', 'Renamed');
    expect(plan.ok).toBe(true);
    // A second owner appears between plan and apply.
    f.store.register('Single', 'Asset/LineB/Other', false, 'PLCInputBool');
    const result = await f.coordinator.apply(plan);
    expect(result.status).toBe('refused');
    expect(result.reason).toContain('Asset/LineB/Other');
    expect(f.coordinator.journal()).toEqual([]);
    expect(f.store.get('Single')).toBeDefined();
    expect(f.asset.opCount).toBe(0);
  });
});
