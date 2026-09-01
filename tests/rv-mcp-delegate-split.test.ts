// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-713 T1 — the delegate-split equivalence gate.
 *
 * Phase 1 moves 45 of the 51 tools that sat directly on `McpBridgePlugin` into
 * three new domain delegates. A code move is only a code move if nothing an
 * agent or a bridge can observe changes, so this test compares the announced
 * catalogue against the baseline frozen in Phase 0 — BEFORE the move — field by
 * field: name, description, inputSchema, readOnlyHint, timeoutMs.
 *
 * The plan's review explicitly rejected pinning tool ORDER: the bridges announce
 * a list, no consumer is promised an order, and pinning one turns every
 * instance-list reshuffle into a false failure. Everything else is verbatim.
 *
 * It also carries the DISPATCH smoke: a schema comparison cannot see a delegate
 * that is announced but never wired into `_sendDiscover`'s instance list, which
 * is precisely the failure mode a split introduces. One call per delegate
 * through the real `_handleCall` closes that gap.
 *
 * `RV_UPDATE_MCP_BASELINE=1 npx vitest run tests/rv-mcp-delegate-split.test.ts`
 * rewrites the baseline through the narrow Node-side command in vite.config.ts.
 * Do that only when the tool surface changed ON PURPOSE, in the same commit.
 */

import { describe, it, expect } from 'vitest';
import { commands } from '@vitest/browser/context';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { generateToolSchemasMulti, buildMultiDispatcher } from '../src/core/engine/rv-mcp-tools';
import { allSchemas, allInstances, delegateCensus } from './helpers/mcp-schemas';
import { buildBaseline, toBaselineTools, type DiscoverBaseline } from './helpers/mcp-baseline';
import BASELINE_RAW from './fixtures/mcp-discover-baseline.json?raw';

/**
 * The Node-side writer, reached the same way `rv-mcp-docs-drift.test.ts` reaches
 * its own: `commands` is typed as an empty registry, and a module augmentation
 * for it does not survive this project's tsconfig. Never throws — without
 * `RV_UPDATE_MCP_BASELINE=1` this is a no-op and the comparisons below are the
 * whole test.
 */
async function writeBaselineBack(contents: string): Promise<boolean> {
  try {
    const cmd = (commands as unknown as Record<string, (...a: unknown[]) => Promise<{
      written: boolean; reason?: string;
    }>>)['writeMcpBaseline'];
    if (typeof cmd !== 'function') return false;
    const out = await cmd(contents);
    return out.written || out.reason === 'already up to date';
  } catch {
    return false;
  }
}

const baseline = JSON.parse(BASELINE_RAW) as DiscoverBaseline;

/**
 * Tools that did not exist when the baseline was frozen, declared by hand.
 *
 * The baseline stays frozen at the PRE-SPLIT catalogue on purpose, and
 * regenerating it for every later phase would throw away both things it is for:
 * the Phase-1 proof that the move changed nothing, and the Phase-0 payload
 * figure T4b measures against. So an addition is declared here instead — one
 * line per tool, in the same commit that adds it.
 *
 * The list is exhaustive in both directions below: a tool that appears without
 * being listed fails, and a listed tool that is not announced fails too. That is
 * what keeps it a declaration rather than a suppression.
 */
const ADDED_SINCE_BASELINE: string[] = [
  // (empty — the baseline was re-frozen with the 2026-08-19 terminology rework,
  // see the note on RETIRED_SINCE_BASELINE.)
].sort();

/**
 * Baseline tools RETIRED on purpose, with the name that replaced each.
 *
 * The counterpart of the additions list, and it carries the replacement rather
 * than just the name because that is the claim being made: F8 retires DUPLICATE
 * PAIRS, so every entry here must still be reachable under another name. The
 * test below checks exactly that, which is what stops this list from becoming a
 * way to delete a capability quietly.
 */
const RETIRED_SINCE_BASELINE: Record<string, string> = {
  // (empty.) The baseline was RE-FROZEN on 2026-08-19 with the terminology
  // rework: asset = document = model, one concept, hard rename with no aliases.
  // web_model_list/_open, web_scene_save/_new/_export, web_library_assets/
  // _update/_list/_describe became web_document_list/_open/_save/_new/_update,
  // web_catalog_list/_describe and web_layout_export (web_document_list also
  // absorbs the former web_library_assets file listing). The Phase-0/Phase-1
  // history this file used to prove lives in git; from here the declarations
  // start again at zero against the re-frozen surface.
};

/**
 * Baseline tools whose DESCRIPTION changed deliberately, and what it must now say.
 *
 * Separate from the additions above because it is a weaker claim and has to look
 * like one: for these two the schema, the annotations and the timeout are still
 * compared verbatim, and only the description is exempt — against a substring
 * that pins WHY it was allowed to change. A blanket exemption would let the next
 * edit rewrite the description into anything at all.
 */
const REDESCRIBED_SINCE_BASELINE: Record<string, string> = {
  // (empty since the 2026-08-19 re-freeze.)
};

/**
 * Baseline tools that gained an OPTIONAL parameter, with the parameter's name.
 *
 * A stronger change than a re-description, so it is declared separately and
 * checked harder: the test below proves the extension is ADDITIVE — every
 * parameter the baseline announced is still there with the same type and
 * description, and the required list is untouched. An agent written against the
 * frozen schema therefore still works, which is the only property that makes
 * adding a parameter to a live tool acceptable at all.
 */
const EXTENDED_SINCE_BASELINE: Record<string, string> = {
  // (empty since the 2026-08-19 re-freeze.)
};

describe('plan-713 T1 — delegate split is observationally neutral', () => {
  const schemas = allSchemas();
  const live = buildBaseline(schemas, delegateCensus());

  it('writes the baseline back when RV_UPDATE_MCP_BASELINE=1 (read-only otherwise)', async () => {
    // Without the flag this is a no-op and the assertions below do the work.
    expect(typeof await writeBaselineBack(`${JSON.stringify(live, null, 2)}\n`)).toBe('boolean');
  });

  it('announces the baseline tools plus exactly the declared additions', () => {
    const liveNames = live.tools.map((t) => t.name);
    const baseNames = baseline.tools.map((t) => t.name);
    expect(liveNames.filter((n) => !baseNames.includes(n)).sort(),
      'tools added since the baseline — declare them in ADDED_SINCE_BASELINE')
      .toEqual(ADDED_SINCE_BASELINE);
    expect(baseNames.filter((n) => !liveNames.includes(n)).sort(),
      'tools LOST since the baseline — declare them in RETIRED_SINCE_BASELINE')
      .toEqual(Object.keys(RETIRED_SINCE_BASELINE).sort());
  });

  it('every retired tool still has its replacement announced', () => {
    const names = new Set(allSchemas().map((s) => s.name));
    for (const [gone, replacement] of Object.entries(RETIRED_SINCE_BASELINE)) {
      expect(names.has(gone), `${gone} is declared retired but is still announced`).toBe(false);
      expect(names.has(replacement),
        `${gone} was retired as a duplicate of ${replacement}, which must still exist`).toBe(true);
    }
  });

  it('every tool the baseline froze is still byte-identical', () => {
    // One deep comparison over the sorted arrays: a per-tool loop would report
    // the first mismatch only, and a split that shifts a description on ten
    // tools should show all ten. Restricted to the frozen names, so a later
    // phase's NEW tool cannot be mistaken for a changed old one — and, more to
    // the point, so adding one can never quietly relax this comparison.
    const added = new Set(ADDED_SINCE_BASELINE);
    const retired = new Set(Object.keys(RETIRED_SINCE_BASELINE));
    // The declared re-descriptions are normalised to the baseline's text FIRST,
    // so everything else about them — schema, annotations, timeout — is still
    // part of the deep comparison below rather than excused along with the prose.
    const baseDescription = new Map(baseline.tools.map((t) => [t.name, t.description]));
    const baseTool = new Map(baseline.tools.map((t) => [t.name, t]));
    const survivors = toBaselineTools(schemas)
      .filter((t) => !added.has(t.name))
      .map((t) => (t.name in REDESCRIBED_SINCE_BASELINE || t.name in EXTENDED_SINCE_BASELINE
        ? { ...t, description: baseDescription.get(t.name) ?? t.description }
        : t))
      // An extended tool's SCHEMA is compared by the additivity test below
      // instead — a deep-equal here could only ever be satisfied by pretending
      // the new parameter is not there.
      .map((t) => (t.name in EXTENDED_SINCE_BASELINE
        ? { ...t, inputSchema: baseTool.get(t.name)?.inputSchema ?? t.inputSchema }
        : t));
    expect(survivors).toEqual(baseline.tools.filter((t) => !retired.has(t.name)));
  });

  it('the tool count is the baseline plus additions minus retirements', () => {
    expect(live.toolCount).toBe(
      baseline.toolCount + ADDED_SINCE_BASELINE.length - Object.keys(RETIRED_SINCE_BASELINE).length,
    );
  });

  it('each declared extension is ADDITIVE — nothing an old caller relied on moved', () => {
    const byName = new Map(allSchemas().map((s) => [s.name, s]));
    for (const [name, param] of Object.entries(EXTENDED_SINCE_BASELINE)) {
      const frozen = baseline.tools.find((t) => t.name === name);
      const now = byName.get(name);
      expect(frozen, `${name} is not in the baseline`).toBeTruthy();
      expect(now, `${name} is declared extended but is not announced`).toBeTruthy();

      const before = frozen!.inputSchema.properties as Record<string, unknown>;
      const after = now!.inputSchema.properties as Record<string, unknown>;
      // Every old parameter survives, unchanged in type AND description.
      for (const [key, spec] of Object.entries(before)) {
        expect(after[key], `${name}.${key} was dropped or altered`).toEqual(spec);
      }
      // Exactly the declared parameter is new.
      expect(Object.keys(after).filter((k) => !(k in before))).toEqual([param]);
      // And it is OPTIONAL — a new required parameter breaks every old caller.
      expect(now!.inputSchema.required, `${name}.${param} must not be required`)
        .toEqual(frozen!.inputSchema.required);
    }
  });

  it('each declared re-description actually says the thing it was allowed for', () => {
    const byName = new Map(allSchemas().map((s) => [s.name, s]));
    for (const [name, must] of Object.entries(REDESCRIBED_SINCE_BASELINE)) {
      const live = byName.get(name);
      expect(live, `${name} is declared re-described but is not announced`).toBeTruthy();
      expect(live!.description, `${name} must mention "${must}"`).toContain(must);
      // And it really is a CHANGE — a stale entry here would otherwise sit
      // forever exempting a description that never moved.
      const frozen = baseline.tools.find((t) => t.name === name);
      expect(frozen, `${name} is not in the baseline — declare it as an ADDITION`).toBeTruthy();
      expect(live!.description).not.toBe(frozen!.description);
    }
  });


  /**
   * plan-713 T4b — the discover payload, REPORTED and PINNED (F11).
   *
   * The plan asked for this as a pass/fail at "≥ 25 % smaller than the Phase-0
   * baseline". The Phase-0 measurement showed that gate is not reachable by any
   * consolidation §2.2 permits: every qualifying merge plus the whole
   * `web_scene_*` retirement came to 6.9 %, because the payload is not spread
   * thinly over many small tools — the `editor` domain alone is ~40 % of it
   * across 55 tools, and the lever there is description LENGTH, not tool count.
   * Chasing 25 % would have meant merging tools that fail criterion 2, 3 or 4,
   * which trades a real property (each tool has one result shape) for a number.
   *
   * So F11 takes the "dokumentierter Befund" branch the plan itself provides,
   * and the test becomes a RATCHET instead of a target: the payload may not grow
   * past a pinned ceiling without somebody choosing to raise it. That catches
   * the failure this gate actually exists for — fifteen tools added over a year,
   * each one "just a little description" — which the 25 % assertion never would
   * have, since it would simply have stayed red.
   */
  describe('T4b — discover payload is measured and pinned, not gated at 25 %', () => {
    /**
     * Ceiling for the announced payload, in bytes.
     *
     * Phase 0 froze 88 119 B over 140 tools. Phase 2-4 add six tools and retire
     * two; the ceiling is set a little above the measured result so ordinary
     * wording edits do not fail CI, and RAISING it is the deliberate act.
     */
    const PAYLOAD_CEILING_BYTES = 96_000;

    it('reports the payload against the Phase-0 baseline', () => {
      const bytes = JSON.stringify(toBaselineTools(schemas)).length;
      const delta = bytes - baseline.payloadBytes;
      const pct = ((delta / baseline.payloadBytes) * 100).toFixed(1);
      // The measurement IS the deliverable of F11 — printed so a reviewer reading
      // CI output sees the number without re-deriving it.
      // eslint-disable-next-line no-console
      console.info(
        `[T4b] discover payload ${bytes} B over ${schemas.length} tools `
        + `(Phase-0 baseline ${baseline.payloadBytes} B over ${baseline.toolCount}; ${pct} %)`,
      );
      expect(bytes).toBeGreaterThan(0);
    });

    it('stays under the pinned ceiling', () => {
      const bytes = JSON.stringify(toBaselineTools(schemas)).length;
      expect(
        bytes,
        `Discover payload ${bytes} B exceeds the pinned ceiling ${PAYLOAD_CEILING_BYTES} B. `
        + 'Shorten descriptions, or raise the pin deliberately in this file.',
      ).toBeLessThanOrEqual(PAYLOAD_CEILING_BYTES);
    });

    it('the editor domain is still where the payload lives — the finding, pinned', () => {
      // Recorded as an assertion so the Phase-0 conclusion stays checkable rather
      // than becoming a paragraph nobody re-measures. If this ever stops being
      // true, the consolidation question is worth reopening.
      const total = JSON.stringify(toBaselineTools(schemas)).length;
      const editor = JSON.stringify(
        toBaselineTools(schemas).filter((t) => t.name.startsWith('web_editor_')),
      ).length;
      expect(editor / total).toBeGreaterThan(0.3);
    });
  });

  describe('dispatch smoke — every announced instance is actually wired', () => {
    it('the dispatcher resolves every announced tool to a callable method', () => {
      const dispatcher = buildMultiDispatcher(allInstances());
      const unwired: string[] = [];
      for (const s of schemas) {
        const entry = dispatcher.get(s.name);
        if (!entry) { unwired.push(`${s.name}: not in dispatcher`); continue; }
        const method = (entry.instance as Record<string, unknown>)[entry.methodKey];
        if (typeof method !== 'function') unwired.push(`${s.name}: ${entry.methodKey} not callable`);
      }
      expect(unwired, unwired.join('\n')).toEqual([]);
    });

    it('the announced schemas and the dispatcher come from ONE instance list', () => {
      // generateToolSchemasMulti and buildMultiDispatcher both throw on a
      // duplicate name, so building both over the same list is the guard R9
      // asks for — and doing it here means a collision fails CI instead of
      // `ws.onopen`, where it would take the whole catalogue down on every
      // reconnect.
      const instances = allInstances();
      expect(() => generateToolSchemasMulti(instances)).not.toThrow();
      expect(() => buildMultiDispatcher(instances)).not.toThrow();
      expect(buildMultiDispatcher(instances).size).toBe(schemas.length);
    });

    it('the plugin instance list matches the one the tests lint', () => {
      // The single most likely way a split goes wrong: a new delegate reaches
      // `_sendDiscover` but not the shared test list (or the reverse), leaving
      // its tools announced-but-unlinted — the exact gap plan-716 had to close
      // for McpProjectTools.
      const plugin = new McpBridgePlugin();
      const fromPlugin = generateToolSchemasMulti(plugin.mcpToolInstances)
        .map((s) => s.name).sort();
      expect(fromPlugin).toEqual(schemas.map((s) => s.name).sort());
    });
  });
});
