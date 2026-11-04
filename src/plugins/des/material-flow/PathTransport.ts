// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * PathTransport.ts -- DES-only capacity-limited transport along an RVPath.
 *
 * Every accepted MU owns an independent duration event and JSON path tween.
 * Capacity limits concurrent transits only; no physics, headway, spacing, or
 * collision system participates in this component.
 */

import type { RVPath } from '../../../core/engine/rv-path';
import { pathFromNode } from '../../../core/engine/rv-path';
import { getDefaultPathNetwork } from '../../../core/engine/rv-path-network';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../../core/material-flow/define-material-flow';
import type {
  FrozenDescriptor,
  MaterialFlowSelf,
} from '../../../core/material-flow/material-flow-self';

interface PathTransportLocal {
  path: RVPath | null;
  speedMmPerSecond: number;
  capacity: number;
  travelTime: number;
}

type PathTransportSelf = MaterialFlowSelf<PathTransportLocal>;

function numeric(self: PathTransportSelf, key: string): number {
  const value = self.prop[key];
  return typeof value === 'number' ? value : Number.NaN;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`PathTransport: ${name} must be greater than zero`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`PathTransport: ${name} must be a positive integer`);
  }
  return value;
}

function discoverPath(self: PathTransportSelf): RVPath | null {
  const node = self.find('path');
  if (!node) return null;
  const path = pathFromNode(node);
  if (!path) return null;
  const network = getDefaultPathNetwork();
  if (!network.get(path.id)) network.register(path);
  return path;
}

export const PathTransport: MaterialFlowDefinition<PathTransportSelf> =
  defineMaterialFlow<PathTransportSelf>({
    type: 'PathTransport',
    kind: 'conveyor',
    models: ['*PathTransport*'],
    description: 'Moves MUs independently along a path with capacity-limited concurrent transit.',
    schema: {
      speed: { type: 'number', default: 1000 },
      capacity: { type: 'number', default: 1 },
    },
    state: (): PathTransportLocal => ({
      path: null,
      speedMmPerSecond: 1000,
      capacity: 1,
      travelTime: 0,
    }),
    capacity: (self): number => self.local.capacity,

    setup(self): void {
      self.local.speedMmPerSecond = positive(numeric(self, 'speed'), 'speed');
      self.local.capacity = positiveInteger(numeric(self, 'capacity'), 'capacity');
      self.local.path = discoverPath(self);
      if (!self.local.path) {
        self.disable('no rv_extras.Path found under the PathTransport root');
        return;
      }
      // RVPath arc length is meters while the user-facing speed is mm/s.
      self.local.travelTime = (self.local.path.length * 1000) / self.local.speedMmPerSecond;
      self.prop.pathRef = self.local.path.id;
      self.prop.pathLength = self.local.path.length;
      self.prop.travelTime = self.local.travelTime;
      self.setState('Empty');
      self.statState('Empty');
    },

    continuous: {},

    des: {
      canAccept(self): boolean {
        return self.local.path !== null && self.currentLoad < self.local.capacity;
      },

      onAccept(self, mu): boolean {
        const path = self.local.path;
        if (!path) return false;
        self.setState('Working');
        self.statState('Working');
        self.in(self.local.travelTime, 'ProcessComplete', mu, {
          phase: 'transit',
          ...self.pathTween(path, 0, path.length, null, mu.id),
        });
        return true;
      },

      onProcessComplete(self, mu, data): void {
        if (!mu || (data as { phase?: unknown } | null)?.phase !== 'transit') return;
        self.transfer(mu);
      },

      onFreeze(self, frozen: readonly FrozenDescriptor[]): void {
        void frozen;
        self.setState('Failure');
        self.statState('Failure');
      },

      onResume(self, frozen: readonly FrozenDescriptor[]): void {
        void frozen;
        self.setState(self.currentLoad > 0 ? 'Working' : 'Empty');
        self.statState(self.currentLoad > 0 ? 'Working' : 'Empty');
      },
    },
  });

export default PathTransport;
