# Embed realvirtual WEB in a website

> **Applies to:** the Community `rv-embed` library, not an iframe of the full HMI or the CONNECT bundled application.
> **Reference baseline:** 6.3.43, reviewed 2026-09-16.

## Build and serve

```bash
npm ci
npm run build:embed
npm run preview:embed
```

Open `http://localhost:4178/test/` for the shipped test page. The build produces
`dist-embed/rv-embed.js`, `chunks/`, `draco/`, the public `vignettes/` model and test
assets. Deploy the entire directory over HTTP(S), preserving its layout. It is
separate from the full application's `dist/` build.

The engine resolves Draco relative to its module location. Copying only
`rv-embed.js` breaks dynamic chunks/decoders. Serve JavaScript with a JavaScript
MIME type and WASM as `application/wasm`. Cross-origin modules/models need CORS;
do not open the page with `file://`.

## Custom element

The following page assumes the embed build is hosted at `/embed/`. It uses the
model shipped by that build. Give the element an explicit height.

```html
<rv-embed id="machine"
  src="/embed/vignettes/conveyor-sensor.glb"
  run="manual"
  interactive="orbit-on-click"
  aria-label="Interactive conveyor model"
  style="width: 100%; height: 420px">
</rv-embed>
<button id="start">Start model</button>
<p id="status" role="status">Ready to start</p>
<script type="module">
  import '/embed/rv-embed.js';
  const element = document.querySelector('#machine');
  const status = document.querySelector('#status');
  element.addEventListener('rv-ready', () => { status.textContent = 'Model loaded'; });
  element.addEventListener('rv-error', ({ detail }) => {
    status.textContent = detail.message;
  });
  document.querySelector('#start').addEventListener('click', async () => {
    try { await element.viewer.play(); }
    catch (error) { status.textContent = String(error); }
  });
</script>
```

| Attribute | Behavior |
|---|---|
| `src` | GLB URL; changing it starts a new model lifecycle |
| `poster` | Optional image shown until the rendered model is ready |
| `run` | `when-visible` (default) or `manual`; automatic boot waits for visibility and respects reduced-motion preference |
| `interactive` | `none`, `orbit-on-click` (default), or `full`; controls interaction/takeover behavior |
| `background` | CSS color; default `#1a1d21`; `transparent` requests alpha |
| `dpr-cap` | Positive device-pixel-ratio limit; default `1.5` |
| `director` | Name of a director script stored in the model |

Wait for `rv-ready` before camera or signal writes. `element.viewer` is a facade
available before loading; the `rv-ready` event's `detail.viewer` is the underlying
`RVEmbedViewer`. They have different API surfaces. `rv-error` supplies a message
and error; director failures can also include step/index/recoverability details.

## Signals, camera and cleanup

```js
// After rv-ready; replace these names with actual signals and full node paths.
const stop = element.viewer.signals.subscribe('SensorOccupied', value => {
  console.log('Sensor:', value);
});
element.viewer.signals.write('ConveyorRun', true);
element.viewer.camera.focus('Machine/Conveyor', { padding: 1.2, durationMs: 400 });
element.viewer.camera.tween({ position: [4, 3, 4], target: [0, 0, 0] }, 600);

// On host component teardown:
stop();
element.viewer.dispose();
element.remove();
```

Signal names are model-specific; `boolean` and `number` values are supported.
Camera positions use scene coordinates; tween durations are milliseconds.
Removing the custom element disposes its lifecycle automatically. Also remove
listeners owned by your host UI when its page/component unmounts.

The custom element manages visibility, hidden tabs, reduced motion, resizing and
multiple instances. Its page-wide manager serializes model loads and grants
simulation ownership to one element at a time; offscreen WebGL contexts can be
recycled. Multiple elements are not independently running simulations.

## Navigation

Once the user has taken over (`interactive`), an embed navigates exactly like the
full viewer with its default settings: the wheel zooms toward the surface under
the cursor (never through it), a trackpad pinch toward the surface under the
fingers, a right-drag orbits around the focus point, a middle-drag pans with the
cursor's point on the plane through the focus point staying under the cursor, and
on touch one finger orbits around the focus point while two fingers pinch toward
the surface under their midpoint and pan. The embed offers neither of the full
viewer's two navigation settings (wheel anchor at the view centre, orbit around
the point under the cursor). Near/far follow the
camera every frame, and **F** / **Shift+F** frame the whole scene (an embed has no
selection). Keys act only in the embed whose canvas
has the focus (a click focuses it); several embeds and a full viewer on one page
do not react to each other. There is no orthographic mode in an embed.

## Direct viewer API

Use the custom element for most pages. A direct viewer requires you to manage its
canvas, resize, visibility, simulation and disposal:

```js
import { RVEmbedViewer } from '/embed/rv-embed.js';

const canvas = document.querySelector('canvas');
const viewer = new RVEmbedViewer({ canvas, background: '#1a1d21', dprCap: 1.5 });
try {
  await viewer.loadModel('/embed/vignettes/conveyor-sensor.glb');
  viewer.resize(canvas.clientWidth, canvas.clientHeight);
  viewer.play();
} catch (error) {
  viewer.dispose();
  throw error;
}
// Host teardown: viewer.dispose(). A disposed viewer cannot be reused.
```

**References are placements in the embed too (plan-757 Phase 2b).** A model that
references other assets (`AssetReference` nodes — a saved layout, a machine built
from sub-assemblies) is loaded like in the main viewer: the loader leaves every
reference node empty and the facade's own placement instancer fills it in through
the same recipe, recursively, one bake per asset. `loadModel` resolves only when
the scene is complete (every reference materialised or failed into a labelled
placeholder); the placed drives and signals join the load result the call returns,
the LogicSteps — the placements' and, once the scene is complete, the model's own
(plan-769 Phase 6, so a step addressed into placed content finds its target) — run
in the facade's one logic engine, and `viewer.placementInstancer` exposes the live state (`progress`,
`getBakeStats()`) for diagnostics. The embed has no Problems panel, so a missing
or refused reference is a `console.warn` line. Relative `path`s in a reference
resolve against the containing file's url; ids resolve through the library
sources registered in the page (a `project:` id needs an open project, which an
embed page has not — use a `path` or a library id).

Do not create concurrent independent direct viewers without coordinating engine
registries and loads; the custom-element manager owns that coordination.
The direct viewer offers `pause()`, `resize(width, height)`, `signals`, `camera`
and `director`. Full types are exported from [src/embed/index.ts](src/embed/index.ts).

## Director and scope

`element.viewer.director.run(script)` runs an `RVEmbedDirectorScript`;
`director.stop()` stops it. A named `director` attribute selects model-authored
steps. Use the exported types and [director implementation](src/embed/rv-embed-director.ts)
for the supported camera, signal, overlay and interaction actions; do not pass an
arbitrary animation format. `RVEmbedUIFragments` supports the director's lightweight
UI fragments, not the full React HMI slot system.

The embed facade excludes the full HMI/plugin system, industrial interfaces,
MCP bridge, commercial editor, post-processing and WebGPU. For those workflows,
embed the full application in an iframe or use the full viewer build. See
[Industrial interfaces](doc-webviewer-interface.md) and
[Extending WEB](doc-extending-webviewer.md).

If rendering fails, check WebGL availability, nonzero layout size, `rv-error`, and
model/chunk/decoder requests. Test the production directory at its final base URL.
