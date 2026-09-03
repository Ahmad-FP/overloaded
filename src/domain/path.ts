import { inBounds, terrainAt, walkable } from "./terrain";
import type { Cell, WorldMap } from "./types";

const key = (cell: Cell) => `${cell.x},${cell.y}`;

export const findPath = (map: WorldMap, start: Cell, goal: Cell): Cell[] | null => {
  if (!inBounds(map, start.x, start.y) || !inBounds(map, goal.x, goal.y)) return null;
  if (!walkable(terrainAt(map, goal.x, goal.y))) return null;
  if (start.x === goal.x && start.y === goal.y) return [start];

  const open: Cell[] = [start];
  const came = new Map<string, Cell>();
  const g = new Map<string, number>([[key(start), 0]]);
  const h = (cell: Cell) => Math.abs(cell.x - goal.x) + Math.abs(cell.y - goal.y);

  while (open.length) {
    open.sort((a, b) => (g.get(key(a)) ?? 1e9) + h(a) - ((g.get(key(b)) ?? 1e9) + h(b)));
    const current = open.shift();
    if (!current) break;
    if (current.x === goal.x && current.y === goal.y) {
      const out = [current];
      let walk: Cell | undefined = current;
      while (came.has(key(walk))) {
        walk = came.get(key(walk));
        if (!walk) break;
        out.unshift(walk);
      }
      return out;
    }
    for (const delta of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const dx = delta[0];
      const dy = delta[1];
      const next = { x: current.x + dx, y: current.y + dy };
      if (!inBounds(map, next.x, next.y) || !walkable(terrainAt(map, next.x, next.y))) continue;
      const step = dx !== 0 && dy !== 0 ? 1.41 : 1;
      const tentative = (g.get(key(current)) ?? 1e9) + step;
      if (tentative < (g.get(key(next)) ?? 1e9)) {
        came.set(key(next), current);
        g.set(key(next), tentative);
        if (!open.some((cell) => cell.x === next.x && cell.y === next.y)) open.push(next);
      }
    }
  }
  return null;
};
