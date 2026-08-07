// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Viewer-mode tests (plan-387).
 *
 * The `viewer` workspace is a pure spectator surface: the model, the running
 * kinematics, Settings and the view/grouping controls — no authoring, no
 * signals, no panels.
 *
 * These tests deliberately re-implement the FIVE slot-host filter semantics
 * (see plan-387 §2.2a/B1) instead of rendering each host, because the same
 * `UIVisibilityRule` means different things depending on who evaluates it:
 *
 *   | Host          | ruleless entry                        |
 *   |---------------|---------------------------------------|
 *   | SlotRenderer  | rule applies ONLY with a visibilityId |
 *   | ButtonPanel   | visible only in hmi / no mode         |
 *   | ActivityBar   | always visible                        |
 *   | MessagePanel  | always visible                        |
 *   | KpiBar        | no filtering at all                   |
 *
 * `otherModes_Unaffected` is the most important test here. Gating a plugin by
 * declaring `modes` compiles a `shownOnlyInAny` onto EVERY one of its slot
 * entries — which turns a ruleless `button-group` entry from "hidden outside
 * hmi for free" into "visible in all four modes". That would be a regression in
 * three shipping workspaces, so this file pins the pre-viewer behaviour of every
 * plugin the plan touches.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ModeManager, modeContext, pluginParticipatesInMode,
  type ModeHost, type ModePluginSets, type ModeId,
} from '../src/core/rv-mode-manager';
import { UIPluginRegistry } from '../src/core/rv-ui-registry';
import { evaluateVisibilityRule } from '../src/core/hmi/ui-context-store';
import {
  WELCOME_AUTO_OPEN_UI_ELEMENT_ID, WELCOME_AUTO_OPEN_VISIBILITY_RULE,
} from '../src/core/hmi/welcome-modal-store';
import buttonPanelSource from '../src/core/hmi/ButtonPanel.tsx?raw';
import topBarSource from '../src/core/hmi/TopBar.tsx?raw';
import activityBarSource from '../src/core/hmi/ActivityBar.tsx?raw';
import { orphanedLeftSlot } from '../src/core/hmi/TopBar';
import {
  LEFT_PANEL_GATES, hiddenLeftPanelSlots,
  HIERARCHY_BROWSER_GATE, ANNOTATION_PANEL_GATE, CONNECT_PANEL_GATE,
  ORDER_PANEL_GATE, MACHINE_CONTROL_PANEL_GATE,
} from '../src/core/hmi/left-panel-visibility';
import type { UISlot, UISlotEntry } from '../src/core/rv-ui-plugin';

import { SimControllerPlugin } from '../src/plugins/sim-controller';
import { ConnectPlugin } from '../src/plugins/connect-plugin';
import { SnapPointPlugin } from '../src/plugins/snap-point';
import { KioskPlugin } from '../src/plugins/kiosk-plugin';
import { OpenerMessagePlugin } from '../src/plugins/opener-message-plugin';
import { WebComponentPlugin } from '../src/plugins/web-component-plugin';

// ─── Harness ──────────────────────────────────────────────────────────────

const EMPTY: ModePluginSets = { enable: [], disable: [], activateHooks: [], deactivateHooks: [] };

/** The two fields that decide participation. Plugins declaring neither are
 *  structurally disjoint from this shape, hence the explicit cast at use sites. */
type ModeGating = { modes?: ModeId[]; core?: boolean };

/** The four workspaces that existed before plan-387. */
const EXISTING_MODES: ModeId[] = ['hmi', 'des', 'planner', 'editor'];

/** The descriptor main.ts registers — kept here so the contract is asserted. */
const VIEWER_DESCRIPTOR = { id: 'viewer', label: 'Viewer', icon: 'ViewInAr', order: 5 } as const;

function makeModes(): ModeManager {
  const host: ModeHost = {
    viewer: {} as never,
    pluginsForMode: () => EMPTY,
    enablePlugin: () => {}, disablePlugin: () => {}, callPlugin: () => {},
    setContext: () => {}, emit: () => {},
  };
  const m = new ModeManager(host);
  m.register(VIEWER_DESCRIPTOR);
  m.register({ id: 'hmi', label: 'HMI', icon: 'ViewQuilt', order: 10 });
  m.register({ id: 'des', label: 'DES', icon: 'AccountTree', order: 20 });
  m.register({ id: 'planner', label: 'Planner', icon: 'GridView', order: 30 });
  m.register({ id: 'editor', label: 'Editor', icon: 'Edit', order: 40, runtime: 'detached' });
  return m;
}

/** Active contexts while `mode` is the active workspace. */
const ctxFor = (mode: ModeId, ...extra: string[]) => new Set([modeContext(mode), ...extra]);

// ─── The five host semantics, mirrored ────────────────────────────────────

/** HMIShell.tsx SlotRenderer — applies a rule ONLY when a visibilityId exists. */
function slotRendererShows(entry: UISlotEntry, contexts: ReadonlySet<string>): boolean {
  if (!entry.visibilityId || !entry.visibilityRule) return true;
  return evaluateVisibilityRule(entry.visibilityRule, contexts);
}

/** ButtonPanel.tsx — ruleless entries are hidden in any focused (non-hmi) mode. */
function buttonPanelShows(
  entry: UISlotEntry, contexts: ReadonlySet<string>, activeMode: ModeId | null,
): boolean {
  if (entry.visibilityRule) return evaluateVisibilityRule(entry.visibilityRule, contexts);
  return !(activeMode !== null && activeMode !== 'hmi');
}

/** ActivityBar.tsx / MessagePanel.tsx — ruleless entries are ALWAYS visible. */
function activityBarShows(entry: UISlotEntry, contexts: ReadonlySet<string>): boolean {
  return !entry.visibilityRule || evaluateVisibilityRule(entry.visibilityRule, contexts);
}

/** Register a plugin and return its compiled entries for one slot. */
function entriesFor(plugin: object, slot: UISlot): UISlotEntry[] {
  const reg = new UIPluginRegistry();
  reg.register(plugin as Parameters<UIPluginRegistry['register']>[0]);
  return reg.getSlotComponents(slot);
}

// ─── F1 — registration ────────────────────────────────────────────────────

describe('viewerMode_IsRegistered', () => {
  it('registers `viewer` with order 5 and the default simulation runtime', () => {
    const modes = makeModes();
    expect(modes.has('viewer')).toBe(true);

    const d = modes.descriptor('viewer')!;
    expect(d.label).toBe('Viewer');
    expect(d.order).toBe(5);
    // F2: the kinematics must RUN. `runtime` is left unset so it falls to the
    // 'simulation' default — unlike the editor, which is explicitly 'detached'.
    expect(d.runtime).toBeUndefined();
    expect(modes.descriptor('editor')!.runtime).toBe('detached');
  });

  it('sorts first in the dropdown, ahead of HMI', () => {
    expect(makeModes().list().map((m) => m.id))
      .toEqual(['viewer', 'hmi', 'des', 'planner', 'editor']);
  });

  it('uses an icon name the ModeDropdown can actually resolve', () => {
    // ModeDropdown falls back to a generic Dashboard icon WITHOUT warning when
    // the name is missing from its ICONS map. `ViewInAr` is in that map; this
    // pins the pairing so renaming the icon cannot silently degrade the entry.
    expect(VIEWER_DESCRIPTOR.icon).toBe('ViewInAr');
  });

  it('activates the mode:viewer context on switch', () => {
    const seen: Array<[string, boolean]> = [];
    const host: ModeHost = {
      viewer: {} as never,
      pluginsForMode: () => EMPTY,
      enablePlugin: () => {}, disablePlugin: () => {}, callPlugin: () => {},
      setContext: (c, a) => { seen.push([c, a]); }, emit: () => {},
    };
    const m = new ModeManager(host);
    m.register(VIEWER_DESCRIPTOR);
    m.setMode('viewer');
    expect(seen).toContainEqual(['mode:viewer', true]);
  });
});

// ─── F8 — deep link ───────────────────────────────────────────────────────

describe('viewerMode_DeepLinkParam', () => {
  it('?mode=viewer resolves through the generic boot path', () => {
    // main.ts boots with: `if (urlMode && viewer.modes.has(urlMode)) setMode(urlMode)`.
    // Registration alone is what makes the deep link work — no extra wiring.
    const modes = makeModes();
    const urlMode = new URLSearchParams('?mode=viewer').get('mode')!;
    expect(modes.has(urlMode)).toBe(true);
    modes.setMode(urlMode);
    expect(modes.activeMode).toBe('viewer');
  });

  it('an unregistered ?mode= value is ignored, leaving the mode unset', () => {
    const modes = makeModes();
    const urlMode = new URLSearchParams('?mode=nope').get('mode')!;
    expect(modes.has(urlMode)).toBe(false);
    expect(modes.activeMode).toBeNull();
  });
});

// ─── Runtime vs UI (R1a) ──────────────────────────────────────────────────

describe('viewerMode_CorePluginRuntimeStillRuns', () => {
  it('a core plugin participates in viewer while its slots stay gated', () => {
    // The feature-matrix shape: core keeps the runtime everywhere, `modes`
    // (without 'viewer') removes only the UI. register() never reads `core`.
    const plugin = { id: 'feature-matrix', core: true, modes: EXISTING_MODES };
    expect(pluginParticipatesInMode(plugin, 'viewer')).toBe(true);

    const [entry] = entriesFor(
      { ...plugin, slots: [{ slot: 'settings-tab', component: (() => null) as never }] },
      'settings-tab',
    );
    expect(entry.visibilityId).toBeTruthy(); // required, or the host ignores the rule
    expect(evaluateVisibilityRule(entry.visibilityRule!, ctxFor('viewer'))).toBe(false);
    expect(evaluateVisibilityRule(entry.visibilityRule!, ctxFor('hmi'))).toBe(true);
  });

  it('kiosk keeps core (idle tours survive) and is gated only on its overlay', () => {
    const kiosk = new KioskPlugin();
    expect(kiosk.core).toBe(true);
    expect(pluginParticipatesInMode(kiosk, 'viewer')).toBe(true);
    // No `modes` — that would have un-gated its ruleless button in three modes.
    expect((kiosk as { modes?: ModeId[] }).modes).toBeUndefined();
  });

  it('the CONNECT gateway keeps running; only its window-opener is gated', () => {
    // Declares neither `modes` nor `core` — so participation falls to the
    // "shared plugin" default: it runs in every mode, viewer included.
    const connect = new ConnectPlugin() as ModeGating;
    expect(connect.modes).toBeUndefined();
    expect(pluginParticipatesInMode(connect, 'viewer')).toBe(true);
  });

  it('the script runtime keeps running; only the Monaco panel is gated', () => {
    const web = new WebComponentPlugin({ allowScripts: true }) as ModeGating;
    expect(web.modes).toBeUndefined();
    expect(pluginParticipatesInMode(web, 'viewer')).toBe(true);
  });
});

// ─── F4 — no authoring entry points ───────────────────────────────────────

describe('viewerMode_NoAuthoringEntryPoints', () => {
  const viewerCtx = ctxFor('viewer');

  it('hides the Play/Pause/Reset sim controls', () => {
    const [leading] = entriesFor(new SimControllerPlugin(), 'toolbar-button-leading');
    expect(slotRendererShows(leading, viewerCtx)).toBe(false);
  });

  it('hides the CONNECT activity-bar entry', () => {
    // ActivityBar shows ruleless entries unconditionally, so this one needs a
    // real rule — a missing rule here would have leaked the PLC surface in.
    const [entry] = entriesFor(new ConnectPlugin(), 'activity-bar');
    expect(entry.visibilityRule).toBeTruthy();
    expect(activityBarShows(entry, viewerCtx)).toBe(false);
  });

  it('hides the snap-point authoring overlay and stops its runtime', () => {
    const snap = new SnapPointPlugin();
    const [overlay] = entriesFor(snap, 'overlay');
    expect(slotRendererShows(overlay, viewerCtx)).toBe(false);
    expect(pluginParticipatesInMode(snap, 'viewer')).toBe(false);
  });

  it('hides the script editor overlay', () => {
    const [overlay] = entriesFor(new WebComponentPlugin({ allowScripts: true }), 'overlay');
    expect(overlay.visibilityId).toBeTruthy();
    expect(slotRendererShows(overlay, viewerCtx)).toBe(false);
  });

  it('never opens the modal opener/welcome dialog', () => {
    // The single worst leak: a spectator following a shared link would be met
    // by a modal. SlotRenderer needs the visibilityId for the rule to apply.
    const opener = new OpenerMessagePlugin({ title: 't', message: 'm' } as never);
    const [overlay] = entriesFor(opener, 'overlay');
    expect(overlay.visibilityId).toBeTruthy();
    expect(overlay.visibilityRule).toBeTruthy();
    expect(slotRendererShows(overlay, viewerCtx)).toBe(false);
  });

  it('hides the kiosk chrome overlay', () => {
    const [overlay] = entriesFor(new KioskPlugin(), 'overlay');
    expect(overlay.visibilityId).toBeTruthy();
    expect(slotRendererShows(overlay, viewerCtx)).toBe(false);
  });
});

// ─── F4 — the welcome dialog does not open itself ─────────────────────────

/**
 * The welcome dialog is NOT a slot entry: LogoBadge (ButtonPanel.tsx) mounts it
 * directly, and the logo lives in the ActivityBar, which the viewer keeps. It is
 * therefore chrome (doc-ui-visibility.md §2 Case 2) and carries its own
 * `useUIVisible` rule. Only the AUTOMATIC first-visit opening is gated — the
 * About click path is untouched, which is why the rule sits on an id of its own
 * instead of on the logo element.
 */
describe('viewerMode_WelcomeModalDoesNotAutoOpen', () => {
  it('registers the auto-open gate under a stable, overridable id', () => {
    expect(WELCOME_AUTO_OPEN_UI_ELEMENT_ID).toBe('welcome-auto-open');
  });

  it('suppresses the first-visit auto-open in the viewer', () => {
    // Without this, a stranger opening a shared link is met by a full-screen
    // modal offering an "HMI Demo" and a "Planner Demo" — an authoring entry
    // point, and the exact opposite of what the workspace is for.
    expect(evaluateVisibilityRule(WELCOME_AUTO_OPEN_VISIBILITY_RULE, ctxFor('viewer'))).toBe(false);
  });

  it('leaves the auto-open unchanged in the four existing modes', () => {
    for (const m of EXISTING_MODES) {
      expect(evaluateVisibilityRule(WELCOME_AUTO_OPEN_VISIBILITY_RULE, ctxFor(m))).toBe(true);
    }
  });

  it('fails OPEN when no mode has booted', () => {
    // `hiddenIn`, not `shownOnlyInAny`: the CONNECT embed path skips mode boot
    // entirely, so a positive rule would have silently killed the dialog there.
    expect(evaluateVisibilityRule(WELCOME_AUTO_OPEN_VISIBILITY_RULE, new Set())).toBe(true);
    expect(evaluateVisibilityRule(WELCOME_AUTO_OPEN_VISIBILITY_RULE, new Set(['embedded']))).toBe(true);
  });

  it('gates only the automatic opening — the logo click stays ungated', () => {
    // Pinned as source text because the split into two state flags IS the
    // mechanism: folding them back into one would re-gate the About button.
    expect(buttonPanelSource).toContain('onClick={() => setManualOpen(true)}');
    expect(buttonPanelSource).toContain('manualOpen || (autoPending && autoOpenAllowed)');
  });
});

// ─── F6 — the regression guard ────────────────────────────────────────────

describe('otherModes_Unaffected', () => {
  /**
   * Pre-plan-387 visibility per existing mode, per touched plugin+slot.
   * Any change to these numbers is a regression in a SHIPPING workspace.
   */
  it('sim-controller: leading toolbar stays planner-only', () => {
    const [leading] = entriesFor(new SimControllerPlugin(), 'toolbar-button-leading');
    const seen = EXISTING_MODES.map((m) => slotRendererShows(leading, ctxFor(m)));
    expect(seen).toEqual([false, false, true, false]); // hmi, des, planner, editor
  });

  it('sim-controller: the mode-switch notice stays ungated everywhere', () => {
    const [notice] = entriesFor(new SimControllerPlugin(), 'overlay');
    // Ruleless by design so it catches every switch; it only ever fires between
    // planner/hmi/des, so it cannot surface from a viewer switch either.
    expect(notice.visibilityId).toBeUndefined();
    for (const m of EXISTING_MODES) expect(slotRendererShows(notice, ctxFor(m))).toBe(true);
  });

  it('connect: the activity-bar entry stays visible in all four modes', () => {
    const [entry] = entriesFor(new ConnectPlugin(), 'activity-bar');
    for (const m of EXISTING_MODES) expect(activityBarShows(entry, ctxFor(m))).toBe(true);
  });

  it('snap-point: the overlay stays visible in all four modes', () => {
    const [overlay] = entriesFor(new SnapPointPlugin(), 'overlay');
    for (const m of EXISTING_MODES) expect(slotRendererShows(overlay, ctxFor(m))).toBe(true);
  });

  it('snap-point: runtime participation is unchanged in all four modes', () => {
    const snap = new SnapPointPlugin();
    for (const m of EXISTING_MODES) expect(pluginParticipatesInMode(snap, m)).toBe(true);
  });

  it('web-component: the overlay stays visible in all four modes', () => {
    const [overlay] = entriesFor(new WebComponentPlugin({ allowScripts: true }), 'overlay');
    for (const m of EXISTING_MODES) expect(slotRendererShows(overlay, ctxFor(m))).toBe(true);
  });

  it('opener-message: the dialog still opens in all four modes', () => {
    const opener = new OpenerMessagePlugin({ title: 't', message: 'm' } as never);
    const [overlay] = entriesFor(opener, 'overlay');
    for (const m of EXISTING_MODES) expect(slotRendererShows(overlay, ctxFor(m))).toBe(true);
  });

  it('kiosk: the overlay stays visible in all four modes', () => {
    const [overlay] = entriesFor(new KioskPlugin(), 'overlay');
    for (const m of EXISTING_MODES) expect(slotRendererShows(overlay, ctxFor(m))).toBe(true);
  });

  /**
   * THE B2 GUARD. A `button-group` entry with no `visibilityRule` is hidden in
   * every focused mode by ButtonPanel itself — for free, and in the viewer too.
   * Declaring `modes` on such a plugin compiles a rule onto the entry, the
   * ruleless branch stops applying, and the button appears in DES/Planner/Editor
   * where it never used to. So these entries must stay ruleless.
   */
  it('button-group entries of touched plugins remain ruleless (hmi-only)', () => {
    const cases: Array<[string, object]> = [
      ['kiosk', new KioskPlugin()],
      ['web-component', new WebComponentPlugin({ allowScripts: true })],
    ];
    for (const [name, plugin] of cases) {
      for (const entry of entriesFor(plugin, 'button-group')) {
        expect(entry.visibilityRule, `${name} button-group must stay ruleless`).toBeUndefined();
        // Pre-existing behaviour, preserved: visible in hmi, hidden elsewhere.
        expect(buttonPanelShows(entry, ctxFor('hmi'), 'hmi')).toBe(true);
        for (const m of ['des', 'planner', 'editor'] as ModeId[]) {
          expect(buttonPanelShows(entry, ctxFor(m), m)).toBe(false);
        }
        // …and therefore already hidden in the viewer at zero cost.
        expect(buttonPanelShows(entry, ctxFor('viewer'), 'viewer')).toBe(false);
      }
    }
  });

  it('declaring modes on a ruleless button-group WOULD regress — pinned', () => {
    // Demonstrates the trap this plan had to avoid, so the reasoning survives
    // in executable form rather than only in a comment.
    const [entry] = entriesFor(
      { id: 'trap', modes: EXISTING_MODES, slots: [{ slot: 'button-group', component: (() => null) as never }] },
      'button-group',
    );
    expect(entry.visibilityRule).toBeTruthy();
    // Now visible in DES/Planner/Editor, where the ruleless entry was hidden.
    for (const m of ['des', 'planner', 'editor'] as ModeId[]) {
      expect(buttonPanelShows(entry, ctxFor(m), m)).toBe(true);
    }
  });

  it('the four existing modes keep their descriptors and order', () => {
    const modes = makeModes();
    expect(modes.descriptor('hmi')!.order).toBe(10);
    expect(modes.descriptor('des')!.order).toBe(20);
    expect(modes.descriptor('planner')!.order).toBe(30);
    expect(modes.descriptor('editor')!.order).toBe(40);
    expect(modes.descriptor('editor')!.runtime).toBe('detached');
    for (const m of EXISTING_MODES) expect(modes.descriptor(m)!.runtime ?? 'simulation')
      .toBe(m === 'editor' ? 'detached' : 'simulation');
  });
});

// ─── F4 follow-up — an open left window must not survive the switch ───────

/**
 * The reported defect: *"der viewer muss ggf. geoeffnete hierarchy auch
 * schliessen wenn beim wechsel offen — hatte hier einen grauen kasten"*.
 *
 * `viewer.leftPanelManager` decides which left window is open AND reserves its
 * width (canvas inset via `useViewportInsets`, plus the floating toolbar
 * offsets). plan-387 hid five left panels through `useUIVisible` but left their
 * slot untouched, so switching into the viewer with one open kept the width
 * reserved for a panel that no longer renders — the grey box. It was reported
 * for the Hierarchy; CONNECT is the sharpest of the five, because `ConnectPlugin`
 * declares neither `modes` nor `core` and therefore runs in every workspace.
 *
 * The fix adds no second mechanism: the gates feed `orphanedLeftSlot`, the
 * reconciliation that already existed for the "renderer absent after a reload"
 * case, through the shared gate↔slot pairings — one list, not five copies of the
 * same check. These tests compose exactly the way TopBar does.
 */
describe('viewerMode_OpenLeftPanelIsReclaimed', () => {
  /** Renderer state with every per-panel flag healthy: only a gate can orphan. */
  const READY = { settingsOpen: true, hierarchyOpen: true };

  /** The hidden-slot set TopBar builds while `mode` is the active workspace. */
  const hiddenIn = (mode: ModeId | null) => {
    const ctx = mode ? ctxFor(mode) : new Set<string>();
    return hiddenLeftPanelSlots(Object.fromEntries(
      LEFT_PANEL_GATES.map((g) => [g.id, evaluateVisibilityRule(g.rule, ctx)]),
    ));
  };

  /** Every gated panel: display name, gate, and its exported constant name. */
  const GATES = [
    ['Hierarchy browser', HIERARCHY_BROWSER_GATE, 'HIERARCHY_BROWSER_GATE'],
    ['Annotations panel', ANNOTATION_PANEL_GATE, 'ANNOTATION_PANEL_GATE'],
    ['CONNECT panel', CONNECT_PANEL_GATE, 'CONNECT_PANEL_GATE'],
    ['Order panel', ORDER_PANEL_GATE, 'ORDER_PANEL_GATE'],
    ['Machine Control panel', MACHINE_CONTROL_PANEL_GATE, 'MACHINE_CONTROL_PANEL_GATE'],
  ] as const;

  it('covers every gate the shared registry declares — no panel left behind', () => {
    expect(GATES.map(([, g]) => g)).toEqual([...LEFT_PANEL_GATES]);
  });

  for (const [name, gate] of GATES) {
    it(`reclaims the ${name} slot ('${gate.slot}') on the switch into the viewer`, () => {
      expect(orphanedLeftSlot(gate.slot, READY, hiddenIn('viewer'))).toBe(gate.slot);
    });
  }

  it('leaves Settings open — the one left window the viewer still offers', () => {
    // Deliberately absent from LEFT_PANEL_GATES: gating it would strand the only
    // panel the spectator surface keeps.
    expect(LEFT_PANEL_GATES.map((g) => g.slot)).not.toContain('settings');
    expect(orphanedLeftSlot('settings', READY, hiddenIn('viewer'))).toBeNull();
  });

  it('Models negotiates no left slot, so it has nothing to reserve', () => {
    // plan-372 §3.5 turned the Models entry into the full-screen Projects
    // dashboard, which owns its open state and no width — which is why the third
    // gated activity-bar entry cannot produce the grey box at all. Only the
    // pre-372 'scene' slot can, and that one is unconditionally orphaned.
    expect(activityBarSource).toContain('const toggleScene = () => toggleProjectsDashboard();');
    expect(activityBarSource).not.toMatch(/lpm\.(open|toggle)\('scene'/);
    expect(orphanedLeftSlot('scene', READY, hiddenIn('viewer'))).toBe('scene');
  });

  it('leaves every slot alone in the four existing workspaces (the way back)', () => {
    // Switching viewer → hmi must not make the panels unreachable: the gates
    // reopen, nothing is reclaimed, and the activity bar can open them again.
    for (const m of EXISTING_MODES) {
      for (const [, gate] of GATES) {
        expect(orphanedLeftSlot(gate.slot, READY, hiddenIn(m)), `${gate.slot} in ${m}`).toBeNull();
      }
    }
  });

  it('fails OPEN when no mode has booted (CONNECT embed path)', () => {
    // The rules are `hiddenIn`, not `shownOnlyInAny` — the embed shell skips mode
    // boot entirely, and closing every left slot there would be a new bug.
    for (const [, gate] of GATES) {
      expect(orphanedLeftSlot(gate.slot, READY, hiddenIn(null)), gate.slot).toBeNull();
    }
  });

  it('every gate names a slot, and no slot is claimed twice', () => {
    const slots = LEFT_PANEL_GATES.map((g) => g.slot);
    expect(slots.every(Boolean)).toBe(true);
    expect(new Set(slots).size).toBe(slots.length);
    expect(new Set(LEFT_PANEL_GATES.map((g) => g.id)).size).toBe(LEFT_PANEL_GATES.length);
  });

  it('TopBar actually feeds those gates in — and re-runs on the switch', () => {
    // Pinned as source text because the wiring IS the fix: the assertions above
    // would keep passing if the composition or the dependency were dropped.
    expect(topBarSource).toContain('hiddenLeftPanelSlots({');
    for (const [, , constName] of GATES) {
      // Both halves: TopBar evaluates the gate AND feeds its slot into the set.
      expect(topBarSource, `${constName} must be evaluated in TopBar`)
        .toContain(`useUIVisible(${constName}.id, ${constName}.rule)`);
      expect(topBarSource, `${constName} must reach the reconciliation`)
        .toContain(`[${constName}.id]:`);
    }
    // A mode switch does NOT change `activePanel`, so all five gates must be in
    // the dependency list or the effect never runs and the width stays reserved.
    expect(topBarSource).toContain(
      'showHierarchyBrowser, showAnnotationPanel, showConnectPanel, showOrderPanel, showMachineControl,',
    );
  });
});

// ─── F5 — iframe ──────────────────────────────────────────────────────────

describe('viewerMode_IframeHidesModeSwitcher', () => {
  const RULE = { hiddenIn: ['embedded'] };

  beforeEach(() => { /* rules are evaluated purely below — no store state needed */ });

  it('the switcher rule hides it when the embedded context is active', () => {
    expect(evaluateVisibilityRule(RULE, new Set(['embedded']))).toBe(false);
  });

  it('the switcher stays visible when not embedded', () => {
    expect(evaluateVisibilityRule(RULE, new Set())).toBe(true);
    expect(evaluateVisibilityRule(RULE, ctxFor('viewer'))).toBe(true);
  });

  it('embedded is independent of the active mode', () => {
    // Embedding hides the way OUT of the app in every workspace, not just the
    // viewer — main.ts sets the context once at boot from window.self !== top.
    for (const m of [...EXISTING_MODES, 'viewer' as ModeId]) {
      expect(evaluateVisibilityRule(RULE, ctxFor(m, 'embedded'))).toBe(false);
    }
  });
});
