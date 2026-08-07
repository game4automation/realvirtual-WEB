# rv-ODT v1 Conformance Suite

Test fixtures for rv-ODT readers. Each case is a pair:

- `NN-name.glb` — a minimal, valid glTF 2.0 binary (JSON chunk only, no geometry)
  whose nodes carry `extras.realvirtual` payloads.
- `NN-name.expected.json` — the exact component state a **conforming reader** must
  produce after parsing that GLB: declared defaults applied, legacy aliases
  migrated to primary field names, enum wire values mapped (including legacy
  integer indices), and `unityCoords` vectors converted to glTF space (X negated).

| Case | Exercises |
|---|---|
| `01-empty-scene` | Node without rv-ODT data → no components |
| `02-single-drive` | All Drive fields set explicitly; enum pass-through |
| `03-drive-with-signal` | ComponentReference preservation + defaults for unset fields |
| `04-transport-with-unitycoords` | `unityCoords` Vector3 → X negation |
| `05-grip-with-enum` | Canonical enum string AND legacy integer-index enum value |
| `06-source-with-aliases` | Legacy field names (`SpawnInterval`, `SpawnDistance`) → primary fields |

## Expected-file format

```json
{
  "description": "What the case exercises",
  "nodes": {
    "<nodeName>": {
      "<ComponentType>": { "<Field>": <parsed value>, ... }
    }
  }
}
```

Notes:

- `ComponentReference` values appear **unresolved** (the raw reference object).
  Reference resolution to live objects/signal addresses is runtime wiring, not
  part of the parsing conformance contract.
- Fields with neither a value in the GLB nor a declared default are absent.
- Vector3 values are given in glTF space (`unityCoords` already applied).

## Running against the reference implementation

realvirtual WEB runs this suite in CI: `tests/conformance.test.ts`.

## Regenerating the GLBs

The binaries are generated (deterministically) by:

```bash
node scripts/generate-conformance-glbs.mjs
```

Edit the scenario definitions in that script, re-run it, and update the
`*.expected.json` files in the same change.

Licensed under CC BY 4.0 (see [`../../LICENSE`](../../LICENSE)).
