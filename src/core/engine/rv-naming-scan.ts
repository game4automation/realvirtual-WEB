/**
 * THE naming-convention scan (plan-582, consolidating plan-753 §5.3 / plan-754 D3b).
 *
 * `Drive-*` / `Transport-*` / `Sensor*` names become rv extras BEFORE anything
 * reads them — the survival model, the pre-bake hooks and the bake's mover cut
 * all decide on extras alone, so a `Transport-Z` that is only a NAME has to
 * become a component first or it would be merged into the static chunk.
 *
 * Idempotent by contract: `applyKinematicsSpec` deep-merges without overwrite,
 * so a tree that was already scanned keeps its extras unchanged. That is what
 * lets the recipe scan a tree its caller may have scanned already.
 *
 * This file exists because the identical body stood in FOUR places
 * (`rv-prepare-and-bake.ts`, `rv-model-cache.ts`, `rv-placement-integrate.ts`
 * and inline in `rv-scene-loader.ts`), two of them with the debug line and two
 * without. Call this one instead of writing a fifth.
 */

import type { Object3D } from 'three';
import { applyKinematicsSpec } from '../behavior-runtime';
import { scanLibraryComponent } from '../library-component-loader';
import { debug } from './rv-debug';

/**
 * Derive Drive/Transport/Sensor extras from node names on `root`.
 * Returns the number of nodes the scan claimed (0 = nothing matched, no write).
 */
export function applyNamingScan(root: Object3D): number {
  const spec = scanLibraryComponent(root);
  const drives = spec.drives?.length ?? 0;
  const transports = spec.transports?.length ?? 0;
  const sensors = spec.sensors?.length ?? 0;
  if (drives === 0 && transports === 0 && sensors === 0) return 0;
  applyKinematicsSpec(root, spec);
  debug('loader', `Naming-convention scan: drives=${drives} transports=${transports} sensors=${sensors}`);
  return drives + transports + sensors;
}
