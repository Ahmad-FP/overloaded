import { TILE_M } from "./constants";
import { blocksLos, cellOf, inBounds, terrainAt } from "./terrain";
import type { WorldMap } from "./types";

export const hasLos = (map: WorldMap, ax: number, az: number, bx: number, bz: number) => {
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (TILE_M * 0.45)));
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const cell = cellOf(x, z);
    if (!inBounds(map, cell.x, cell.y)) return false;
    if (blocksLos(terrainAt(map, cell.x, cell.y))) return false;
  }
  return true;
};
