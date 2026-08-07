// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useRef, useState } from 'react';
import type { RVLogicEngine, StepStateInfo } from '../core/engine/rv-logic-engine';
import { subscribeTick } from './shared-ui-ticker';

function readStepInfo(engine: RVLogicEngine, path: string): StepStateInfo | null {
  const info = engine.getStepInfo(path);
  if (!info) return null;
  return {
    ...info,
    elapsed: info.elapsed === undefined ? undefined : Math.round(info.elapsed * 10) / 10,
  };
}

function materiallyEqual(a: StepStateInfo | null, b: StepStateInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.state === b.state
    && a.reason === b.reason
    && a.duration === b.duration
    && a.elapsed === b.elapsed;
}

/**
 * Poll one LogicStep row on the shared 200 ms UI ticker. Null arguments disable
 * both polling and ticker acquisition, allowing callers to obey Rules of Hooks.
 */
export function useStepState(
  engine: RVLogicEngine | null,
  path: string | null,
): StepStateInfo | null {
  const [value, setValue] = useState<StepStateInfo | null>(
    () => engine && path ? readStepInfo(engine, path) : null,
  );
  const sourceRef = useRef({ engine, path });

  useEffect(() => {
    const sourceChanged = sourceRef.current.engine !== engine || sourceRef.current.path !== path;
    sourceRef.current = { engine, path };

    if (!engine || !path) {
      setValue((previous) => previous === null ? previous : null);
      return;
    }

    if (sourceChanged) setValue(readStepInfo(engine, path));

    return subscribeTick(() => {
      const next = readStepInfo(engine, path);
      setValue((previous) => materiallyEqual(previous, next) ? previous : next);
    });
  }, [engine, path]);

  return value;
}
