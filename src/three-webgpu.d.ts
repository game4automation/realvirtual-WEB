// Type declarations for three/webgpu module
// WebGPURenderer extends Renderer (NOT WebGLRenderer) since r167+

// WebGPU globals (navigator.gpu, GPUCanvasContext, ...): up to @types/three 0.171 these
// came in transitively via its @webgpu/types dependency; @types/three 0.185 dropped that
// dependency, so we reference the official types explicitly.
/// <reference types="@webgpu/types" />

declare module 'three/webgpu' {
  import { ShadowMapType } from 'three';

  // Renderer base class (new universal renderer)
  export class Renderer {
    readonly domElement: HTMLCanvasElement;
    shadowMap: { enabled: boolean; type: ShadowMapType };
    toneMapping: number;
    toneMappingExposure: number;
    info: {
      /** `calls` is cumulative on three/webgpu (never reset); `drawCalls` is per frame. */
      render?: { triangles?: number; calls?: number; drawCalls?: number; frameCalls?: number };
      memory?: { geometries?: number; textures?: number };
      programs?: unknown[];
    };
    xr: {
      enabled: boolean;
      isPresenting: boolean;
      setSession(session: XRSession): Promise<void>;
      getSession(): XRSession | null;
      setReferenceSpaceType(type: string): void;
      getReferenceSpace(): XRReferenceSpace | null;
      getController(index: number): import('three').Group;
      getControllerGrip(index: number): import('three').Group;
      getCamera(): import('three').ArrayCamera;
      addEventListener(type: string, listener: () => void): void;
    };

    init(): Promise<void>;
    render(scene: import('three').Scene, camera: import('three').Camera): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setPixelRatio(ratio: number): void;
    getPixelRatio(): number;
    setClearColor(color: unknown, alpha?: number): void;
    getClearColor(target: import('three').Color): import('three').Color;
    getClearAlpha(): number;
    setAnimationLoop(callback: ((time: DOMHighResTimeStamp) => void) | null): void;
    setRenderTarget(target: unknown): void;
    dispose(): void;
    getContext(): GPUCanvasContext | WebGL2RenderingContext;
    compileAsync(object: import('three').Object3D, camera: import('three').Camera, scene: import('three').Scene): Promise<void>;

    readonly isRenderer: true;
    readonly backend: { isWebGPUBackend?: boolean };
    readonly initialized: boolean;
  }

  export class WebGPURenderer extends Renderer {
    constructor(parameters?: {
      antialias?: boolean;
      alpha?: boolean;
      forceWebGL?: boolean;
      canvas?: HTMLCanvasElement;
    });
    readonly isWebGPURenderer: true;
  }

  // Clipping under WebGPURenderer (plan-271 Phase 2 finding, plan-162):
  // `material.clippingPlanes` is NOT consumed by the WebGPU renderer in
  // r185 — clipping works exclusively via ClippingGroup scene nodes.
  export class ClippingGroup extends import('three').Group {
    clippingPlanes: import('three').Plane[];
    clipIntersection: boolean;
    clipShadows: boolean;
    enabled: boolean;
    readonly isClippingGroup: true;
  }

  // Node materials (plan-271 Phase 2 TSL ports). Type-only re-exports from
  // the real @types/three declarations — the runtime classes come from the
  // actual three/webgpu build; these deep 'three/src/…' specifiers are never
  // emitted (this is a .d.ts), so no dual-three-instance risk.
  export { default as NodeMaterial } from 'three/src/materials/nodes/NodeMaterial.js';
  export { default as MeshBasicNodeMaterial } from 'three/src/materials/nodes/MeshBasicNodeMaterial.js';
  export { default as MeshStandardNodeMaterial } from 'three/src/materials/nodes/MeshStandardNodeMaterial.js';
  export { default as MeshToonNodeMaterial } from 'three/src/materials/nodes/MeshToonNodeMaterial.js';

  // Compute storage attribute (plan-271 Phase 4 MU compute spike) — same
  // type-only re-export pattern as the node materials above.
  export { default as StorageInstancedBufferAttribute } from 'three/src/renderers/common/StorageInstancedBufferAttribute.js';

  // TSL node post-processing (plan-271 Phase 3). Minimal declarations
  // matching the r185 runtime — declared here (not re-exported from
  // 'three/src/…') because the real d.ts types them against @types/three's
  // own Renderer class, which is structurally incompatible with the minimal
  // Renderer declared above.
  /** r183+ name of the former `PostProcessing` class. `render()` REPLACES
   *  `renderer.render()` when a TSL effect chain is active. */
  export class RenderPipeline {
    constructor(renderer: Renderer, outputNode?: unknown);
    outputNode: unknown;
    /** Disable when the output node already applies renderOutput(). */
    outputColorTransform: boolean;
    /** Set to true when the output node graph changed. */
    needsUpdate: boolean;
    render(): void;
    dispose(): void;
  }
  /** Scene-to-texture pass node (three/src/nodes/display/PassNode.js) — the
   *  class behind `pass()` from 'three/tsl'. Minimal surface: what the
   *  overlay-layer pass subclass in rv-post-processing-tsl.ts overrides. */
  export class PassNode {
    static readonly COLOR: string;
    constructor(
      scope: string,
      scene: import('three').Scene,
      camera: import('three').Camera,
      options?: { samples?: number },
    );
    scene: import('three').Scene;
    camera: import('three').Camera;
    /** Restrict the pass render to these layers — replaces the camera's
     *  layer mask for the duration of the pass (restored afterwards). */
    setLayers(layers: import('three').Layers): this;
    getTextureNode(name?: string): unknown;
    /** Renders the scene into the pass target. Runs once per frame before
     *  the output quad, in graph order. */
    updateBefore(frame: { renderer: Renderer }): void;
    dispose(): void;
  }
  /** Fullscreen quad helper (three/src/renderers/common/QuadMesh.js). */
  export class QuadMesh {
    constructor(material?: import('three').Material);
    material: import('three').Material;
    render(renderer: Renderer): void;
  }

  // Re-export everything else from three
  export * from 'three';
}
