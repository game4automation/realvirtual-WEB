// Type declarations for three/webgpu module
// WebGPURenderer extends Renderer (NOT WebGLRenderer) since r167+
declare module 'three/webgpu' {
  import { ShadowMapType } from 'three';

  // Renderer base class (new universal renderer)
  export class Renderer {
    readonly domElement: HTMLCanvasElement;
    shadowMap: { enabled: boolean; type: ShadowMapType };
    toneMapping: number;
    toneMappingExposure: number;
    info: {
      render?: { triangles?: number; calls?: number };
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

  // Re-export everything else from three
  export * from 'three';
}
