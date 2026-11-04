// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseTutorial, SCHEMA_ID } from '../scripts/tutorial/lib/tutorial-schema.mjs';
import { frameBudget } from '../scripts/tutorial/lib/tutorial-events.mjs';

function pilotStoryboard(): Record<string, unknown> {
  return {
    $schema: SCHEMA_ID,
    id: 'pilot',
    title: 'Pilot tutorial',
    url: '/?mcpPort=1',
    steps: [{
      id: 'show-model',
      actions: [
        { type: 'camera', position: [1, 2, 3], target: [0, 0, 0] },
        { type: 'waitFor', scene: true },
      ],
    }],
  };
}

describe('tutorial-schema', () => {
  it('Test_Schema_ValidPilot_Accepted', () => {
    const tutorial = parseTutorial(pilotStoryboard());
    expect(tutorial).toMatchObject({
      $schema: 'rv-tutorial/1',
      connect: 'off',
      viewport: { width: 1920, height: 1080 },
      welcome: 'dismiss',
      ready: '#rv-viewport',
      minStepSec: 2,
      motionRegion: { x: 760, y: 500, w: 400, h: 400 },
      setup: [],
    });
    expect(tutorial.steps[0]).toMatchObject({ zoom: 'auto', tailSec: 0.4, holdSec: 2 });
    expect(tutorial.steps[0].actions[0]).toMatchObject({ type: 'camera', durationSec: 0.6 });
    expect(tutorial.steps[0].actions[1]).toMatchObject({ type: 'waitFor', timeoutMs: 60000 });
  });

  it('Test_Schema_ConnectDefaultOffAndExplicitLive_Accepted', () => {
    expect(parseTutorial(pilotStoryboard()).connect).toBe('off');
    expect(parseTutorial({ ...pilotStoryboard(), connect: 'live' }).connect).toBe('live');
  });

  it('Test_Schema_OptionalDurationsAreNormalised_NeverUndefined', () => {
    const tutorial = parseTutorial(pilotStoryboard());
    const camera = tutorial.steps[0].actions.find((action) => action.type === 'camera');
    const waitFor = tutorial.steps[0].actions.find((action) => action.type === 'waitFor');
    expect(camera).toMatchObject({ durationSec: 0.6 });
    expect(waitFor).toMatchObject({ timeoutMs: 60000 });
    expect(camera).not.toHaveProperty('durationSec', undefined);
    expect(waitFor).not.toHaveProperty('timeoutMs', undefined);
  });

  it('Test_Schema_HoldSecDefaultsToMinStepSec', () => {
    const custom = pilotStoryboard();
    custom.minStepSec = 3.25;
    expect(parseTutorial(custom).steps[0].holdSec).toBe(3.25);
    expect(parseTutorial(pilotStoryboard()).steps[0].holdSec).toBe(2);
  });

  it('Test_Schema_NoVoiceField_Accepted', () => {
    const tutorial = pilotStoryboard();
    expect(tutorial).not.toHaveProperty('voice');
    expect(() => parseTutorial(tutorial)).not.toThrow();
  });

  it('Test_Schema_ParkedTtsFields_ToleratedNotRequired', () => {
    const tutorial = pilotStoryboard();
    tutorial.voice = { provider: 'parked' };
    const step = (tutorial.steps as Array<Record<string, unknown>>)[0];
    step.say = 'A future voice-over line';
    expect(() => parseTutorial(tutorial)).not.toThrow();
  });

  it('Test_Schema_UnknownActionType_Rejected_IncludingHold', () => {
    for (const type of ['hold', 'unknown']) {
      const tutorial = pilotStoryboard();
      const step = (tutorial.steps as Array<Record<string, unknown>>)[0];
      step.actions = [{ type }];
      expect(() => parseTutorial(tutorial)).toThrow();
    }
  });

  it('Test_Schema_DuplicateStepId_Rejected', () => {
    const tutorial = pilotStoryboard();
    const first = (tutorial.steps as Array<Record<string, unknown>>)[0];
    tutorial.steps = [first, { id: 'show-model', actions: [{ type: 'press', key: 'Escape' }] }];
    expect(() => parseTutorial(tutorial)).toThrow(/duplicate step id/);
  });

  it('Test_Schema_StepIdNotFilenameSafe_Rejected', () => {
    for (const id of ['a/b', 'A B']) {
      const tutorial = pilotStoryboard();
      const step = (tutorial.steps as Array<Record<string, unknown>>)[0];
      step.id = id;
      expect(() => parseTutorial(tutorial)).toThrow(/step id/);
    }
  });

  it('Test_Schema_WaitForWithoutSelectorOrScene_Rejected', () => {
    const tutorial = pilotStoryboard();
    const step = (tutorial.steps as Array<Record<string, unknown>>)[0];
    step.actions = [{ type: 'waitFor' }];
    expect(() => parseTutorial(tutorial)).toThrow(/waitFor needs either/);
  });

  it('Test_Schema_OtherMajorVersion_Rejected', () => {
    const tutorial = pilotStoryboard();
    tutorial.$schema = 'rv-tutorial/2';
    expect(() => parseTutorial(tutorial)).toThrow();
  });
});

describe('tutorial-schema command/pick/targets (plan-2031 P2)', () => {
  const pick = { type: 'pick', rule: 'moving-vehicle', among: '/Vehicles/*', as: 'agv' };
  const references = [
    { type: 'hover', target: { node: '$agv' } },
    { type: 'hover', target: { recordingTarget: 'des-stats-bar', key: '$agv' } },
    { type: 'command', id: 'selection.select', via: 'direct', args: { items: [{ path: '$agv' }] } },
  ];
  const storyboard = (actions: Record<string, unknown>[]) => ({
    ...pilotStoryboard(), steps: [{ id: 'show-model', actions }],
  });

  it('Test_Command_DefaultsAndDirectArgs_Preserved', () => {
    const args = { position: [1, 2, 3], options: { enabled: true } };
    const script = parseTutorial(storyboard([
      { type: 'command', id: 'sim.reset' },
      { type: 'command', id: 'camera.flyTo', via: 'direct', args },
    ]));
    expect(script.steps[0].actions[0]).toMatchObject({
      type: 'command', id: 'sim.reset', via: 'click', waitSec: 0.3, maxWaitSec: 30,
    });
    expect(script.steps[0].actions[1]).toMatchObject({ via: 'direct', args });
  });

  it('Test_Pick_SampleDuration_Defaulted', () => {
    expect(parseTutorial(storyboard([pick])).steps[0].actions[0]).toEqual({ ...pick, sampleSec: 0.3 });
  });

  it('Test_Pick_InvalidBindingName_Rejected', () => {
    for (const as of ['', '$agv', '1agv', 'moving-vehicle', 'two words']) {
      expect(() => parseTutorial(storyboard([{ ...pick, as }]))).toThrow();
    }
  });

  it('Test_Targets_NewVariants_ParsedWithDefaults', () => {
    const targets = [
      { command: 'camera.follow', buttonKey: 'follow' },
      { node: '/Vehicles/AGV' },
      { node: '/Vehicles/AGV', anchor: 'top' },
      { recordingTarget: 'des-stats-bar', key: '/Vehicles/AGV' },
    ];
    const script = parseTutorial(storyboard(targets.map((target) => ({ type: 'hover', target }))));
    expect(script.steps[0].actions.map((action) => action.type === 'hover' ? action.target : undefined)).toEqual([
      targets[0], { ...targets[1], anchor: 'center' }, targets[2], targets[3],
    ]);
    for (const target of targets) {
      expect(() => parseTutorial(storyboard([{ type: 'hover', target: { ...target, unknown: true } }]))).toThrow();
    }
  });

  it('Test_Bindings_EarlierPickInSameStep_Accepted', () => {
    expect(() => parseTutorial(storyboard([pick, ...references]))).not.toThrow();
  });

  it('Test_Bindings_EarlierStep_Accepted', () => {
    expect(() => parseTutorial({
      ...storyboard([pick]),
      steps: [{ id: 'pick', actions: [pick] }, { id: 'use', actions: references }],
    })).not.toThrow();
  });

  it('Test_Bindings_SetupPick_AcceptedInSetupAndSteps', () => {
    expect(() => parseTutorial({ ...storyboard(references), setup: [pick, ...references] })).not.toThrow();
  });

  it('Test_Bindings_UnboundTargetsAndNestedArgs_RejectedWithName', () => {
    for (const reference of references) {
      expect(() => parseTutorial(storyboard([reference]))).toThrow(/\$agv/);
    }
  });

  it('Test_Bindings_UseBeforePickInSameStep_Rejected', () => {
    for (const reference of references) {
      expect(() => parseTutorial(storyboard([reference, pick]))).toThrow(/\$agv/);
    }
  });

  it('Test_Bindings_DuplicateAs_RejectedAcrossScopes', () => {
    const scripts = [
      storyboard([pick, pick]),
      { ...storyboard([pick]), setup: [pick] },
      { ...storyboard([pick]), steps: [{ id: 'first', actions: [pick] }, { id: 'second', actions: [pick] }] },
    ];
    for (const script of scripts) expect(() => parseTutorial(script)).toThrow(/duplicate pick binding 'agv'/);
  });

  it('Test_FastForward_UntilSimTime_OnlyAllowedInSetup', () => {
    const command = { type: 'command', id: 'des.fastForward', args: { untilSimTime: '00:02:00:00' } };
    expect(() => parseTutorial(storyboard([command]))).toThrow(/untilSimTime.*setup/);
    expect(() => parseTutorial({ ...pilotStoryboard(), setup: [command] })).not.toThrow();
    expect(() => parseTutorial(storyboard([{ type: 'command', id: 'des.fastForward' }]))).not.toThrow();
  });

  it('Test_Start_DefaultRunningAndExplicitPaused_Accepted', () => {
    expect(parseTutorial(pilotStoryboard()).start).toBe('running');
    expect(parseTutorial({ ...pilotStoryboard(), start: 'paused' }).start).toBe('paused');
    expect(() => parseTutorial({ ...pilotStoryboard(), start: 'stopped' })).toThrow();
  });

  it('Test_Durations_NewActionDefaultsAndBudget_AllFinite', () => {
    const script = parseTutorial({
      ...storyboard([pick, ...references, { type: 'command', id: 'sim.reset' }]),
      setup: [{ type: 'command', id: 'sim.reset', via: 'direct' }, { ...pick, as: 'setupAgv' }],
    });
    for (const action of [...script.setup, ...script.steps.flatMap((step) => step.actions)]) {
      if (action.type === 'command') {
        expect(Number.isFinite(action.waitSec)).toBe(true);
        expect(Number.isFinite(action.maxWaitSec)).toBe(true);
      }
      if (action.type === 'pick') expect(Number.isFinite(action.sampleSec)).toBe(true);
    }
    expect(Number.isFinite(frameBudget(script, 30).max)).toBe(true);
  });

  it('Test_DemoBasics_ExistingStoryboard_ParsesWithRunningStart', () => {
    const raw = JSON.parse(readFileSync(
      new URL('../scripts/tutorial/storyboards/demo-basics.json', import.meta.url), 'utf8',
    ));
    expect(parseTutorial(raw).start).toBe('running');
  });

  it('Test_Schema_Stamp_DefaultProof_InlineAllowed', () => {
    expect(parseTutorial(pilotStoryboard()).stamp).toBe('proof');
    expect(parseTutorial({ ...pilotStoryboard(), stamp: 'inline' }).stamp).toBe('inline');
  });

  it.each(['band', 20, null])('Test_Schema_Stamp_%s_RefusedNamingTheField', (value) => {
    expect(() => parseTutorial({ ...pilotStoryboard(), stamp: value })).toThrow(/stamp:/);
  });

  it('Test_AiKinematize_StartsEmptyEditorAndNamesTheStepImport', () => {
    const raw = JSON.parse(readFileSync(
      new URL('../scripts/tutorial/storyboards/ai-kinematize.json', import.meta.url), 'utf8',
    ));
    const tutorial = parseTutorial(raw);
    const typeAction = tutorial.steps
      .flatMap((step) => step.actions)
      .find((action) => action.type === 'type');

    expect(tutorial).toMatchObject({ url: '/?doc=new&mode=editor', connect: 'live' });
    expect(tutorial.setup).toContainEqual(expect.objectContaining({
      type: 'waitFor', selector: '[data-testid="unified-import-dialog"]',
    }));
    expect(typeAction).toMatchObject({
      type: 'type',
      target: { selector: '[data-rv-ai="input"]' },
    });
    if (typeAction?.type !== 'type') throw new Error('AI storyboard has no type action');
    expect(typeAction.text).toContain('tools/solidcraft/agv-stacker/agv-stacker.step');
    expect(typeAction.text).toContain('web_editor_import_cad');
    expect(typeAction.text).toContain('web_help');
    expect(typeAction.text).toContain('kinematize');
  });
});
