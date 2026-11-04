// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Processing.ts -- central DES processing-time attachment.
 *
 * The component owns no MUs. After every runner adapter exists, its onGenerate
 * hook resolves targetComponentPath and configures the target adapter. The
 * adapter applies the hold at the target's declared processing point and owns
 * the snapshot/failure-safe remaining-time descriptor.
 */

import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../../core/material-flow/define-material-flow';
import type {
  MaterialFlowSelf,
} from '../../../core/material-flow/material-flow-self';
import { DES } from '../rv-des-api';
import { MaterialFlowAdapter } from '../material-flow-adapter';

interface ProcessingLocal {
  targetComponentPath: string;
  processingTime: number;
}

type ProcessingSelf = MaterialFlowSelf<ProcessingLocal>;

function resolveTarget(path: string): MaterialFlowAdapter {
  const target = DES.getManager()?.getComponentByPath(path);
  if (!(target instanceof MaterialFlowAdapter)) {
    throw new Error(`Processing: targetComponentPath '${path}' did not resolve to a runner adapter`);
  }
  return target;
}

function sourcePath(self: ProcessingSelf): string {
  const manager = DES.getManager();
  if (manager) {
    for (let i = 0; i < manager.componentCount; i++) {
      const component = manager.getComponentByEntityId(i);
      if (
        component instanceof MaterialFlowAdapter
        && component.self as unknown === self as unknown
      ) return component.path;
    }
  }
  return self.root.name;
}

export const Processing: MaterialFlowDefinition<ProcessingSelf> = defineMaterialFlow<ProcessingSelf>({
  type: 'Processing',
  kind: 'downtime',
  models: ['*Processing*'],
  description: 'Adds failure-safe processing time to any DES component.',
  schema: {
    targetComponentPath: { type: 'string', default: '' },
    processingTime: { type: 'number', default: 1 },
  },
  state: (): ProcessingLocal => ({
    targetComponentPath: '',
    processingTime: 1,
  }),

  setup(self): void {
    const targetPath = self.prop.targetComponentPath;
    const processingTime = self.prop.processingTime;
    if (typeof targetPath !== 'string' || targetPath.trim() === '') {
      throw new Error('Processing: targetComponentPath must be a non-empty string');
    }
    if (typeof processingTime !== 'number' || !Number.isFinite(processingTime) || processingTime <= 0) {
      throw new Error('Processing: processingTime must be greater than zero');
    }
    self.local.targetComponentPath = targetPath.trim();
    self.local.processingTime = processingTime;
    self.setState('Empty');
    self.statState('Empty');
  },

  continuous: {},

  des: {
    onGenerate(self): void {
      const target = resolveTarget(self.local.targetComponentPath);
      target.configureProcessingAttachment(self.local.processingTime, sourcePath(self));
      self.prop.targetResolvedPath = target.path;
    },
  },
});

export default Processing;
