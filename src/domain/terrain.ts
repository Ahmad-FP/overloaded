import { TILE_M } from "./constants";
import type { Cell, Terrain, UnitType, WorldMap } from "./types";

const tileIndex = (map: WorldMap, x: number, y: number) => y * map.width + x;

export const inBounds = (map: WorldMap, x: number, y: number) =>
  x >= 0 && y >= 0 && x < map.width && y < map.height;

export const cellOf = (x: number, z: number): Cell => ({
  x: Math.floor(x / TILE_M),
  y: Math.floor(z / TILE_M),
});

export const cellCenter = (cell: Cell) => ({
  x: (cell.x + 0.5) * TILE_M,
  z: (cell.y + 0.5) * TILE_M,
});

export const terrainAt = (map: WorldMap, x: number, y: number): Terrain => {
  if (!inBounds(map, x, y)) return "water";
  return map.tiles[tileIndex(map, x, y)] ?? "water";
};

export const heightAt = (map: WorldMap, x: number, z: number) => {
  const cell = cellOf(x, z);
  if (!inBounds(map, cell.x, cell.y)) return 0;
  return map.heights[tileIndex(map, cell.x, cell.y)] ?? 0;
};

export const walkable = (terrain: Terrain) => terrain !== "water" && terrain !== "building";

export const blocksLos = (terrain: Terrain) => terrain === "woods" || terrain === "building";

export const blocksShot = (terrain: Terrain) => terrain === "woods" || terrain === "building";

export const speedScale = (terrain: Terrain, kind: UnitType | "commander") => {
  const mounted = kind === "cavalry" || kind === "commander";
  switch (terrain) {
    case "road":
      return 1.25;
    case "rough":
      return mounted ? 0.45 : kind === "artillery" ? 0.4 : 0.75;
    case "woods":
      return mounted ? 0.35 : kind === "artillery" ? 0.3 : 0.7;
    case "open":
      return 1;
    default:
      return 0;
  }
};

export const baseSpeed = (kind: UnitType | "commander") => {
  if (kind === "cavalry") return 9.5;
  if (kind === "commander") return 8.4;
  if (kind === "artillery") return 2.6;
  return 4.4;
};

export const musketCone = (weapon: number, powder: number) => 0.14 - weapon * 0.028 + (3 - powder) * 0.018;
export const musketRange = (powder: number) => 70 + powder * 32;
export const musketReload = (weapon: number, powder: number) => 4.6 - weapon * 0.55 - powder * 0.2;
export const artilleryBlast = (calibre: number) => 6 + calibre * 4;
export const artilleryReload = (calibre: number) => 9.5 - calibre * 1.4;
export const limberSpeed = (calibre: number) => 1.8 + calibre * 0.7;
