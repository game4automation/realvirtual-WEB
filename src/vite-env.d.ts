/// <reference types="vite/client" />

/** True when the private sibling folder (realvirtual-WebViewer-Private~) is present at build time. */
declare const __RV_HAS_PRIVATE__: boolean;

/** True when building with RV_COMMERCIAL=1 env var. Hides AGPL watermark. */
declare const __RV_COMMERCIAL__: boolean;
