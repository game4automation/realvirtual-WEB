# realvirtual Open Digital Twin Format (rv-ODT)

**rv-ODT** is an open format for self-describing industrial digital twins: a single
standard glTF/GLB file carries the 3D geometry **and** the complete component
configuration of a machine or plant — drives, sensors, conveyors, material sources
and sinks, grippers, robot kinematics, PLC signal wiring, and 3D-HMI markers.

- **Machine-readable spec:** [`v1/rv-odt.json`](./v1/rv-odt.json) — JSON Schema 2020-12; 30 components, 26 logic steps, 6 PLC signal types, scene structure and recording types, with per-field descriptions
- **Human-readable spec:** [`v1/specification.md`](./v1/specification.md) — RFC-2119 specification
- **Conformance suite:** [`v1/conformance/`](./v1/conformance/) — test GLBs + expected reader output
- **Canonical URL:** `https://realvirtual.io/schema/odt/v1/rv-odt.json`

## Quick start (reading rv-ODT data)

rv-ODT data lives in each glTF node's standard `extras` object under the key
`realvirtual`. Any glTF loader gives you access to it — no special runtime required:

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const gltf = await new GLTFLoader().loadAsync('machine.glb');
gltf.scene.traverse((node) => {
  const rv = node.userData?.realvirtual;         // three.js maps extras -> userData
  if (rv?.Drive) {
    console.log(node.name, 'is a drive:', rv.Drive.Direction, rv.Drive.TargetSpeed);
  }
});
```

Validate a component block against the schema with any JSON Schema 2020-12
validator (e.g. ajv):

```js
import Ajv2020 from 'ajv/dist/2020.js';
import rvOdt from './v1/rv-odt.json' with { type: 'json' };

const ajv = new Ajv2020({ strict: false });
const validate = ajv.compile({ ...rvOdt.$defs.Drive, $defs: rvOdt.$defs });
console.log(validate({ Direction: 'LinearX', TargetSpeed: 200 }));
```

## Who uses it

- **realvirtual WEB** — the AGPL browser viewer/simulator is the reference
  implementation; its runtime component schemas are loaded directly from
  `rv-odt.json` (zero drift by construction).
- **realvirtual Unity framework** — exports rv-ODT GLBs from Unity scenes.
- **Third-party tools** — Blender add-ons, CAD pipelines, CI validators,
  documentation generators. The format is open; build on it.

## Stability commitment

The canonical `/schema/odt/v1/rv-odt.json` URL serves the **latest compatible 1.x**
schema and changes only through the documented additive release process. Every minor
release is also published as a byte-immutable snapshot under `/schema/odt/v1.N/`.
realvirtual GmbH commits to keeping the canonical and snapshot URLs reachable until
at least **2037**, matching the documentation-availability horizon of EU Machinery
Regulation 2023/1230.

## License

Everything in this `schema/` directory — `rv-odt.json`, `specification.md`, the
conformance fixtures, and this README — is licensed under
**Creative Commons Attribution 4.0 International (CC BY 4.0)**, see [`LICENSE`](./LICENSE).
You may implement readers and writers freely, including commercially, with attribution
("realvirtual Open Digital Twin Format, © realvirtual GmbH").

The realvirtual WEB **reference implementation** (the surrounding repository) is
licensed separately under AGPL-3.0-only with a commercial option — the CC BY 4.0
grant applies only to this `schema/` subtree.

## Versioning & governance

- Semantic versioning; v1 minor updates are strictly additive (new components,
  new optional fields, new enum values).
- Every 1.x release is recorded with its SHA-256 in [`RELEASES.md`](./RELEASES.md).
- Proposals via issues/PRs on the public repository
  ([game4automation/realvirtual-WEB](https://github.com/game4automation/realvirtual-WEB)).
- See `specification.md` Sections 10-11 for the full rules.
