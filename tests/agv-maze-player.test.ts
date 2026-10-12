// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { RVPathNetwork } from '@rv/core/engine/rv-path-network';
import { PathTraveler } from '@rv/core/engine/rv-path-traveler';
import { buildMazeGraph } from '../src/plugins/models/agv-maze/maze-builder';
import { parseMazeMap, type Cell } from '../src/plugins/models/agv-maze/maze-map';
import { PLAYER_SPEED, PlayerControl } from '../src/plugins/models/agv-maze/player-control';

function setup(ascii = '#######\n#P...G#\n#.###.#\n#..D..#\n#######') {
  const map = parseMazeMap(ascii), network = new RVPathNetwork(), graph = buildMazeGraph(map, network);
  const traveler = new PathTraveler('player', network.get('e_r1c1_r1c2'), network), arrivals: Cell[] = [];
  const control = new PlayerControl(traveler, map, graph, cell => arrivals.push(cell));
  traveler.v = PLAYER_SPEED;
  return { map, network, graph, traveler, control, arrivals };
}
describe('AGV Maze player control', () => {
  it('buffers a turn, keeps travelling straight until that direction exists', () => {
    const f = setup(); f.control.setDesired('S'); f.control.tick(0.5);
    expect(f.traveler.path!.id).toBe('e_r1c1_r1c2');
    f.control.tick(3.6);
    expect(f.traveler.path!.id).toBe('e_r1c5_r2c5'); expect(f.control.desired).toBe('S');
    expect(f.arrivals).toHaveLength(4);
  });
  it('reverses immediately with identical world position and no pickup', () => {
    const f = setup(); f.control.tick(0.65);
    const before = f.traveler.getPosition(new Vector3()); f.control.setDesired('W');
    expect(f.traveler.path!.id).toBe('e_r1c2_r1c1'); expect(f.traveler.s).toBeCloseTo(0.42);
    expect(f.traveler.getPosition(new Vector3()).distanceTo(before)).toBeLessThan(1e-10);
    f.control.tick(0.2); expect(f.arrivals).toHaveLength(0);
  });
  it('holds at a wall with unchanged orientation, then restarts at s=0', () => {
    const f = setup(); f.traveler.path = f.network.get('e_r1c4_r1c5'); f.traveler.s = 1.14;
    f.control.setDesired('N'); const before = new Quaternion(); f.traveler.getPose(new Vector3(), before);
    f.control.tick(1 / 60); f.control.tick(1 / 60); f.control.tick(1 / 60); f.control.tick(1 / 60);
    expect(f.traveler.path!.id).toBe('e_r1c4_r1c5'); expect(f.traveler.s).toBe(f.traveler.path!.length); expect(f.traveler.v).toBe(0);
    const after = new Quaternion(); f.traveler.getPose(new Vector3(), after); expect(after).toEqual(before);
    expect(f.traveler.getPosition(new Vector3())).toEqual(new Vector3(6, 0, 1.2)); expect(f.arrivals).toHaveLength(1);
    f.control.setDesired('S'); f.control.tick(1 / 60);
    expect(f.traveler.path!.id).toBe('e_r1c5_r2c5'); expect(f.traveler.s).toBe(0); expect(f.traveler.v).toBe(PLAYER_SPEED);
    expect(f.arrivals).toHaveLength(1);
  });
  it('reports exact equality once, including the following carry tick', () => {
    const f = setup(); f.control.tick(1); expect(f.arrivals).toHaveLength(1);
    f.control.tick(1 / 60); expect(f.arrivals).toHaveLength(1); expect(f.traveler.path!.id).toBe('e_r1c2_r1c3');
  });
  it('shares keyboard and D-pad input and removes the listener', () => {
    const f = setup(); const off = f.control.bindKeyboard(window, () => true, dir => f.control.setDesired(dir));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); expect(f.control.desired).toBe('S');
    f.control.setDesired('N'); expect(f.control.desired).toBe('N'); off();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); expect(f.control.desired).toBe('N');
  });
});
