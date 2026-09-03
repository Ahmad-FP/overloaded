import {
  INTERDICT_STRUCTURE_TILES, INTERDICT_TILES, MAX_SUPPLY, TILE_M,
} from "./constants";
import { inBounds, terrainAt, walkable } from "./terrain";
import type { Cell, Side, Structure, Unit, WorldMap } from "./types";

/**
 * Who can move supply through each tile.
 *
 * A convoy does not get shot at by a battalion it can see; it gets stopped by
 * one standing on the road. So interdiction is a stamped radius around enemy
 * bodies and enemy works, not a line of sight test — it is a thing the player
 * can look at, walk around, and clear by force.
 *
 * One byte per tile, one grid per side, rebuilt twice a second.
 */
export type ControlField = {
  width: number;
  height: number;
  /** 1 where this side's supply may not pass. */
  blocked: Uint8Array;
};

const stamp = (field: ControlField, cx: number, cy: number, radius: number) => {
  const r = Math.ceil(radius);
  for (let y = cy - r; y <= cy + r; y += 1) {
    for (let x = cx - r; x <= cx + r; x += 1) {
      if (x < 0 || y < 0 || x >= field.width || y >= field.height) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
      field.blocked[y * field.width + x] = 1;
    }
  }
};

export const buildControl = (
  map: WorldMap,
  side: Side,
  units: Iterable<Unit>,
  structures: Iterable<Structure>,
): ControlField => {
  const field: ControlField = {
    width: map.width,
    height: map.height,
    blocked: new Uint8Array(map.width * map.height),
  };
  for (const unit of units) {
    if (!unit.alive || unit.side === side) continue;
    stamp(field, Math.floor(unit.x / TILE_M), Math.floor(unit.z / TILE_M), INTERDICT_TILES);
  }
  for (const structure of structures) {
    if (structure.side === side || structure.side === "neutral") continue;
    stamp(field, structure.cell.x, structure.cell.y, INTERDICT_STRUCTURE_TILES);
  }
  return field;
};

/**
 * A route home, or nothing.
 *
 * Breadth-first from the structure to the side's main base over walkable,
 * un-interdicted ground. BFS rather than A*: the shortest hop count is the
 * route a quartermaster would actually use, and on a 56x56 field the whole
 * search is a few thousand cells.
 *
 * The main base's own footprint is always passable, otherwise a base with an
 * enemy raider parked beside it could never be reached even by itself.
 */
export const routeHome = (
  map: WorldMap,
  from: Cell,
  home: Cell,
  control: ControlField,
): Cell[] | null => {
  const { width, height } = map;
  const index = (x: number, y: number) => y * width + x;
  if (!inBounds(map, from.x, from.y) || !inBounds(map, home.x, home.y)) return null;
  const came = new Int32Array(width * height).fill(-1);
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const start = index(from.x, from.y);
  queue[tail] = start;
  tail += 1;
  seen[start] = 1;
  const goal = index(home.x, home.y);
  const steps: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (head < tail) {
    const current = queue[head] ?? -1;
    head += 1;
    if (current < 0) break;
    if (current === goal) {
      const out: Cell[] = [];
      let walk = current;
      while (walk >= 0) {
        out.unshift({ x: walk % width, y: Math.floor(walk / width) });
        walk = came[walk] ?? -1;
      }
      return out;
    }
    const cx = current % width;
    const cy = Math.floor(current / width);
    for (const [dx, dy] of steps) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = index(nx, ny);
      if (seen[next]) continue;
      if (!walkable(terrainAt(map, nx, ny))) continue;
      if (control.blocked[next] && next !== goal) continue;
      seen[next] = 1;
      came[next] = current;
      queue[tail] = next;
      tail += 1;
    }
  }
  return null;
};

/** Crates per minute a side is drawing right now. */
export const incomeOf = (structures: Iterable<Structure>, side: Side) => {
  let total = 0;
  for (const structure of structures) {
    if (structure.side !== side || !structure.connected || structure.build < 1) continue;
    total += structure.yield;
  }
  return total;
};

export const bank = (current: number, gained: number) =>
  Math.max(0, Math.min(MAX_SUPPLY, current + gained));
