// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import { describe, expect, it, vi } from 'vitest';
import { RVPathNetwork } from '@rv/core/engine/rv-path-network';
import { PathTraveler } from '@rv/core/engine/rv-path-traveler';
import { MazeGame, type GameEvents } from '../src/plugins/models/agv-maze/game-state';
import { buildMazeGraph } from '../src/plugins/models/agv-maze/maze-builder';
import { parseMazeMap } from '../src/plugins/models/agv-maze/maze-map';
import { PLAYER_SPEED, PlayerControl } from '../src/plugins/models/agv-maze/player-control';

function setup(ascii = '#######\n#P.o.G#\n#.###.#\n#..D..#\n#######') {
  const map = parseMazeMap(ascii), network = new RVPathNetwork(), graph = buildMazeGraph(map, network);
  const events: GameEvents = { resetPositions: vi.fn(), resetGhosts: vi.fn(), frightened: vi.fn(), eatGhost: vi.fn(), pellet: vi.fn(), resetPellets: vi.fn() };
  const values: Record<string, number | boolean> = {};
  const game = new MazeGame(map, { setMany: data => Object.assign(values, data) }, events);
  return { map, network, graph, events, values, game };
}
describe('AGV Maze game state', () => {
  it('counts each pellet once and wins on the last order', () => {
    const f = setup(); f.game.start(); f.game.arriveAt(f.map.pellets[0]); f.game.arriveAt(f.map.pellets[0]);
    expect(f.values['Maze.Score']).toBe(10); expect(f.values['Maze.PelletsLeft']).toBe(8);
    for (const cell of f.map.pellets) f.game.arriveAt(cell);
    for (const cell of f.map.powerPellets) f.game.arriveAt(cell);
    expect(f.values['Maze.State']).toBe(4); expect(f.values['Maze.Score']).toBe(130);
  });
  it('loses lives, waits 1.5 seconds, and ends after three captures', () => {
    const f = setup();
    for (let life = 2; life >= 0; life--) {
      f.game.start(); f.game.contact(0, 'chase'); expect(f.values['Maze.Lives']).toBe(life);
      expect(f.game.state).toBe(life ? 2 : 3); f.game.contact(1, 'chase'); expect(f.values['Maze.Lives']).toBe(life);
      for (let i = 0; i < 90; i++) f.game.tick(1 / 60);
      expect(f.game.state).toBe(life ? 0 : 3);
    }
  });
  it('keeps Open Source active for eight seconds and awards an eaten ghost', () => {
    const f = setup(); f.game.start(); f.game.arriveAt(f.map.powerPellets[0]); f.game.contact(2, 'frightened');
    expect(f.values['Maze.Score']).toBe(250); expect(f.events.eatGhost).toHaveBeenCalledWith(2);
    for (let i = 0; i < 479; i++) f.game.tick(1 / 60);
    expect(f.values['Maze.Frightened']).toBe(true); f.game.tick(1 / 60); expect(f.values['Maze.Frightened']).toBe(false);
  });
  it('restarts signals and positions without re-registering the graph', () => {
    const f = setup(), paths = f.network.all(); f.game.start(); f.game.arriveAt(f.map.pellets[0]); f.game.restart();
    expect(f.values).toEqual({ 'Maze.Score': 0, 'Maze.Lives': 3, 'Maze.PelletsLeft': 9, 'Maze.State': 0, 'Maze.Frightened': false });
    expect(f.network.all()).toEqual(paths); expect(f.events.resetPositions).toHaveBeenCalledTimes(2);
  });
  it('does not collect a cell never reached after a reversal', () => {
    const f = setup(), traveler = new PathTraveler('player', f.network.get('e_r1c1_r1c2'), f.network);
    const player = new PlayerControl(traveler, f.map, f.graph, cell => f.game.arriveAt(cell));
    f.game.start(); traveler.v = PLAYER_SPEED; player.tick(0.65); player.setDesired('W'); player.tick(0.1);
    expect(f.values['Maze.Score']).toBe(0);
  });
  it.each(['.', 'o'])('counts a wall-stop %s once and does not recount when restarting', symbol => {
    const f = setup(`#######\n#P.G.${symbol}#\n#.###.#\n#..D..#\n#######`);
    const traveler = new PathTraveler('player', f.network.get('e_r1c4_r1c5'), f.network);
    const player = new PlayerControl(traveler, f.map, f.graph, cell => f.game.arriveAt(cell));
    f.game.start(); traveler.v = PLAYER_SPEED; player.setDesired('N'); player.tick(1);
    expect(f.values['Maze.Score']).toBe(symbol === 'o' ? 50 : 10);
    expect(f.values['Maze.Frightened']).toBe(symbol === 'o'); player.tick(1); player.setDesired('S'); player.tick(1 / 60);
    expect(f.events.pellet).toHaveBeenCalledTimes(1);
  });
  it('wins when the last pellet is the wall-stop node', () => {
    const f = setup('#######\n#P G .#\n# ### #\n#  D  #\n#######');
    const traveler = new PathTraveler('player', f.network.get('e_r1c4_r1c5'), f.network);
    const player = new PlayerControl(traveler, f.map, f.graph, cell => f.game.arriveAt(cell));
    f.game.start(); traveler.v = PLAYER_SPEED; player.setDesired('N'); player.tick(1);
    expect(f.game.state).toBe(4); expect(f.values['Maze.Score']).toBe(10);
  });
});
