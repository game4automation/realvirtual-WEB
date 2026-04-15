/**
 * Type augmentations for three-mesh-bvh prototype patching.
 * When computeBoundsTree/disposeBoundsTree are assigned to BufferGeometry.prototype,
 * TypeScript needs to know these methods exist.
 */
import type { MeshBVH } from 'three-mesh-bvh';

declare module 'three' {
  interface BufferGeometry {
    boundsTree?: MeshBVH;
    computeBoundsTree(options?: Record<string, unknown>): void;
    disposeBoundsTree(): void;
  }
}
