# AGV Maze

AGV Maze is a public maze-chase sales demo for realvirtual WEB. Drive the realvirtual vehicle through an original warehouse grid, collect orders and evade four travelling control cabinets.

## Open and play

Open the viewer with `?model=agv-maze.glb` or select **AGV Maze** in the model selection, and press the viewer's **Play** control. An arrow key, WASD or the on-screen direction pad starts the game. Pause with the viewer's simulation control; **Restart** starts a fresh round with three lives. A direction stays buffered until it is possible. The opposite direction reverses immediately; an impassable straight route stops at the junction.

Normal orders score 10 points. **Open Source** pickups score 50 and put the pursuers into a fault state for eight seconds. Contact with a faulty cabinet scores 200; only its signal column returns to the charging station before the cabinet restarts. Other contact costs one life. Collect every order to win. **Mute** disables the optional synthesized sounds; browser audio starts only after input.

The model binds `src/plugins/models/agv-maze/index.ts` by the matching lowercase model and plugin-folder name, without an open project or `scriptRef`. Its filename deliberately contains neither `Agv` nor `AGV`. `public/demo-realvirtual/agv-maze.glb` is a byte-identical copy of the documented DiscreteEventSimulation vehicle. No other project content is required.

## Map syntax

Edit `DEFAULT_MAZE` in `maze-map.ts`. Rows must have equal lengths and the outer boundary must be walls. All walkable cells must be connected, with exactly one player and charging station and at least one pursuer spawn. The supplied level has four distinct pursuer spawns and a charging spur.

| Character | Meaning |
| --- | --- |
| `#` | Wall |
| `.` | Order |
| `o` | Open Source pickup |
| space | Empty corridor |
| `P` | Player start |
| `G` | Pursuer start |
| `D` | Charging station |

Cell size defaults to 1.2 meters. Cell centers are `(column * cellSize, 0, row * cellSize)`. Each neighboring pair produces two directed paths. Successors exclude immediate reversal except at a dead end. Restart preserves these paths; unloading removes only this plugin's registrations.

## Pursuers and tuning

Names, neutral role colors, phase durations and pursuer speeds live in `ghost-router.ts`. Names are fictional wordplay and parody; there are no manufacturer logos or brand color schemes.

| Pursuer | Role in chase mode |
| --- | --- |
| Simans | Targets the player's cell |
| Rockwall | Targets four cells ahead, clamped to a walkable cell |
| Schnitter | Reflects the Simans-to-player vector beyond the player |
| Kuckuck | Chases at eight or more grid steps; otherwise heads for its corner |

The phase schedule alternates scatter/chase for `7, 20, 7, 20, 5, 20, 5, Infinity` seconds. Open Source pauses that clock. Default speeds are 1200 mm/s for the player (`player-control.ts`), 1080 for normal pursuers, 660 in fault mode and 1800 when returning to charge. Random junction choices use seed 42, reset on restart.

## What this demonstrates

The demo uses the production `RVPath`, `RVPathNetwork`, `PathTraveler`, central `setRouter` contract and `nextHopToward` Dijkstra routing. A directed segment BFS selects a reachable target entrance before asking Dijkstra for the next hop. The vehicle dynamics deliberately use arcade turns without `Agv` acceleration, spacing, fleet tasks or DES coupling. Do not pitch it as a full fleet-dispatch simulation.

The player decides junction behavior before advancing and reports each node arrival itself. The loaded document is hidden; the player GLB and four procedural cabinets are attached directly to the scene, outside static batching and matrix freezing. Loading is tracked and generation-guarded. Model clear releases paths, router, listeners, audio, meshes, materials and textures.

## Tests and delivery

Run from the public sibling:

```powershell
npx.cmd tsc --noEmit
npx.cmd vitest run --config vitest.node.config.ts agv-maze-map.node.test.ts
npx.cmd vitest run agv-maze-game.test.ts agv-maze-player.test.ts agv-maze-ghosts.test.ts agv-maze-smoke.test.ts
npm.cmd run test
```

The five test files live in the public repository's `tests/` directory. The implementation report in plan 470 records the actual commands, environment limitations and remaining acceptance checks. Deployment and publication belong to the orchestrator; this source delivery does not claim a hosted URL or a completed physical-phone test.

## Night warehouse visual pass

The HUD uses the shell's `overlay` slot and remains available in Viewer mode: score, lives, Restart, sound and the direction pad require no workspace switch. The 68-degree starting camera fits the maze on load and resize. A white nose chevron shows travel direction; an amber chevron shows a different buffered direction.

The grid uses +X for east and -Z for north, so arrow keys match the screen from the starting camera. Each corridor has one turquoise floor marking. The generic path visualizer is temporarily removed, including its chevrons and editing listeners, then restored with its previous enabled/user-disabled state and registration origin on unload.

Each pursuer occasionally speaks for three seconds, followed by an 18–22 second pause. Sprites and their Canvas textures are owned by the vehicle and disposed on unload. Staggered speech uses an independent sequence derived from the same maze seed as routing and resets on restart. Fault mode shows `STOERUNG F-0471`, blinks the signal column red (faster in the last two seconds), and turns the cabinet/chassis backwards while keeping the reduced travel speed. Eaten mode still shows only the signal column.

Turquoise emissive floor lanes, warm spherical orders, pulsing larger Open Source pickups and bright signal columns sit against a matte near-black floor. The plugin temporarily uses the existing bloom controls and its own lights; scene lighting, background and bloom settings are restored on unload.

Walls use only geometry/material from `library/PalletHandling/Europallet.glb`, never its Source/MU-bearing nodes or extras. One InstancedMesh holds four 144 mm pallets per wall cell. Stack rotation and small offsets use an independent seed-42 sequence. Speeds shrink with the 1.2 m grid to preserve traversal time; capture radius stays 0.45 cells (0.54 m), ambush look-ahead stays four cells (4.8 m).
