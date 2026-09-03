import { BANK_CLEARANCE_M, MIN_DEPTH_M, WATER_LEVEL_M } from "./constants";
import { ridgedFbm, vnoise } from "./noise";
import type { Cell, MapId, Side, Terrain, WorldMap } from "./types";

/**
 * Organic feature painters.
 *
 * Every feature on every field used to be an axis-aligned rectangle: woods
 * were squares, the village was one solid 8x8 block, and roads were straight
 * bands the full width of the map. That is legible from the air and nothing
 * else — it is why the command map read as blobs, and why the village in the
 * 3D view was a grid rather than a settlement strung along its lane.
 *
 * These are all deterministic: the same map id always produces the same
 * ground, so two people who pick the same map fight over the same field.
 */

const put = (tiles: Terrain[], width: number, height: number, x: number, y: number, kind: Terrain) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  tiles[y * width + x] = kind;
};

/**
 * A wood, or any soft-edged patch. An ellipse whose boundary is pushed in and
 * out by smooth noise, so it has lobes and bays instead of corners.
 */
const copse = (
  tiles: Terrain[],
  width: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  kind: Terrain,
  seed = 0,
  ragged = 0.85,
) => {
  const height = tiles.length / width;
  for (let y = Math.floor(cy - ry * 1.7); y <= Math.ceil(cy + ry * 1.7); y += 1) {
    for (let x = Math.floor(cx - rx * 1.7); x <= Math.ceil(cx + rx * 1.7); x += 1) {
      const r2 = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      const edge = 1 + (vnoise(x * 0.24 + seed, y * 0.24 - seed) - 0.5) * ragged;
      if (r2 < edge) put(tiles, width, height, x, y, kind);
    }
  }
};

/**
 * A road, lane or watercourse: a polyline walked at sub-tile steps, with the
 * centreline wandering under smooth noise and the width breathing along it.
 * A straight band across a map is a survey line, not a road anyone built.
 */
const track = (
  tiles: Terrain[],
  width: number,
  through: Array<[number, number]>,
  half: number,
  kind: Terrain,
  seed = 0,
  wander = 1.5,
) => {
  const height = tiles.length / width;
  for (let leg = 0; leg < through.length - 1; leg += 1) {
    const a = through[leg] as [number, number];
    const b = through[leg + 1] as [number, number];
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(2, Math.ceil(span * 4));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      let cx = a[0] + (b[0] - a[0]) * t;
      let cy = a[1] + (b[1] - a[1]) * t;
      // Push perpendicular to the leg so the lane meanders rather than
      // shimmering in place.
      const nx = -(b[1] - a[1]) / Math.max(1e-6, span);
      const ny = (b[0] - a[0]) / Math.max(1e-6, span);
      const drift = (vnoise(cx * 0.09 + seed, cy * 0.09 + seed) - 0.5) * 2 * wander;
      cx += nx * drift;
      cy += ny * drift;
      const w = half * (0.78 + vnoise(cx * 0.3 - seed, cy * 0.3 + seed) * 0.5);
      for (let dy = -Math.ceil(w); dy <= Math.ceil(w); dy += 1) {
        for (let dx = -Math.ceil(w); dx <= Math.ceil(w); dx += 1) {
          if (dx * dx + dy * dy <= w * w) put(tiles, width, height, Math.round(cx) + dx, Math.round(cy) + dy, kind);
        }
      }
    }
  }
};

/**
 * A settlement: plots strung along one side of a lane and then the other,
 * with gaps between them. Villages grow along the road they sit on; they do
 * not arrive as a solid rectangle of masonry.
 */
const hamlet = (
  tiles: Terrain[],
  width: number,
  through: Array<[number, number]>,
  plots: number,
  kind: Terrain,
  seed = 0,
) => {
  const height = tiles.length / width;
  const a = through[0] as [number, number];
  const b = through[through.length - 1] as [number, number];
  const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const nx = -(b[1] - a[1]) / Math.max(1e-6, span);
  const ny = (b[0] - a[0]) / Math.max(1e-6, span);
  for (let i = 0; i < plots; i += 1) {
    const t = (i + 0.5) / plots;
    const side = i % 2 === 0 ? 1 : -1;
    const jog = (vnoise(i * 1.7 + seed, i * 0.9 - seed) - 0.5) * 1.6;
    const off = side * (2.1 + vnoise(i * 2.3 + seed, seed) * 1.2);
    const cx = a[0] + (b[0] - a[0]) * t + nx * off + ny * jog;
    const cy = a[1] + (b[1] - a[1]) * t + ny * off - nx * jog;
    // Plots stay small and separate. At three tiles across they merge into
    // one mass of masonry and the street disappears.
    const w = vnoise(i * 3.1 + seed, i) > 0.55 ? 1 : 0;
    const d = vnoise(i, i * 3.1 + seed) > 0.5 ? 1 : 0;
    for (let dy = -d; dy <= d; dy += 1) {
      for (let dx = -w; dx <= w; dx += 1) {
        put(tiles, width, height, Math.round(cx) + dx, Math.round(cy) + dy, kind);
      }
    }
  }
};

/**
 * A field boundary: a single-tile line of `rough` following a polyline, with
 * the occasional gate left in it. Hedges are what make enclosed country read
 * as enclosed, and they cost a formation its order to cross.
 */
const hedge = (tiles: Terrain[], width: number, through: Array<[number, number]>, seed = 0) => {
  const height = tiles.length / width;
  for (let leg = 0; leg < through.length - 1; leg += 1) {
    const a = through[leg] as [number, number];
    const b = through[leg + 1] as [number, number];
    const span = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const steps = Math.max(2, Math.ceil(span * 2));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const cx = Math.round(a[0] + (b[0] - a[0]) * t + (vnoise(i * 0.7 + seed, seed) - 0.5) * 1.2);
      const cy = Math.round(a[1] + (b[1] - a[1]) * t + (vnoise(seed, i * 0.7 + seed) - 0.5) * 1.2);
      // Gates: a hedge with no way through it is a wall.
      if (vnoise(i * 1.9 + seed, i * 0.4) > 0.78) continue;
      if (tiles[cy * width + cx] === "open") put(tiles, width, height, cx, cy, "rough");
    }
  }
};

const wet = (tiles: Terrain[], width: number, height: number, x: number, y: number) => {
  const n: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  return n.some(([dx, dy]) => {
    const nx = x + dx;
    const ny = y + dy;
    return nx >= 0 && ny >= 0 && nx < width && ny < height && tiles[ny * width + nx] === "water";
  });
};

/** A gaussian ridge along a line, in normalised map space. */
const ridgeAt = (u: number, v: number, axis: "u" | "v", at: number, width: number, crest: number) => {
  const d = (axis === "v" ? v : u) - at;
  return Math.exp(-((d / width) ** 2)) * crest;
};

/** A gaussian hill. */
const knollAt = (u: number, v: number, cu: number, cv: number, radius: number, crest: number) =>
  Math.exp(-(((u - cu) ** 2 + (v - cv) ** 2) / (radius * radius))) * crest;

/**
 * The tactical skeleton of each field, in metres above the datum.
 *
 * Worked in normalised coordinates so a map keeps its shape whatever its tile
 * count. Amplitudes are chosen against real ground: the position Wellington
 * held at Waterloo stood some fifteen to twenty metres over the valley it
 * covered, and that is the order these need to be. The previous generator gave
 * the village field about 1.3 m of variation across 560 m, which is a table,
 * not a battlefield — no reverse slope, no dead ground, no reason to want one
 * piece of it more than another.
 */
const landform = (id: MapId, u: number, v: number) => {
  if (id === "ridge") {
    // One dominant crest with a re-entrant cut into it, and a lower counter
    // ridge opposite, so both sides have ground worth holding.
    return (
      ridgeAt(u, v, "v", 0.42, 0.13, 19) * (1 - knollAt(u, v, 0.52, 0.42, 0.1, 0.75)) +
      ridgeAt(u, v, "v", 0.78, 0.16, 7.5) +
      knollAt(u, v, 0.18, 0.34, 0.14, 4)
    );
  }
  if (id === "plain") {
    // Open, but not featureless: one commanding knoll and a long shallow swell.
    return knollAt(u, v, 0.34, 0.26, 0.19, 13) + ridgeAt(u, v, "u", 0.72, 0.22, 5);
  }
  if (id === "longfield") {
    // Corrugated: parallel swells a cavalry line can disappear behind.
    return Math.sin(v * Math.PI * 3.1) * 3.6 + ridgeAt(u, v, "u", 0.2, 0.16, 8) + knollAt(u, v, 0.82, 0.62, 0.15, 5.5);
  }
  // village: a ridge across the north, the settlement in a saddle below it,
  // and the ground falling away south into the stream.
  return (
    ridgeAt(u, v, "v", 0.24, 0.12, 15) +
    knollAt(u, v, 0.74, 0.36, 0.13, 6) -
    ridgeAt(u, v, "v", 0.86, 0.18, 5.5) -
    knollAt(u, v, 0.5, 0.55, 0.17, 3)
  );
};

const sculpt = (id: MapId, width: number, height: number, tiles: Terrain[]) => {
  const raw = tiles.map((kind, i) => {
    const x = i % width;
    const y = Math.floor(i / width);
    const u = x / Math.max(1, width - 1);
    const v = y / Math.max(1, height - 1);
    // Broad undulation over the landform, so no slope is a clean ramp.
    const roll = (ridgedFbm(x * 0.09 + 4.1, y * 0.085 + 2.7) - 0.42) * 5.2;
    const fine = (ridgedFbm(x * 0.26 + 11, y * 0.24 + 3) - 0.45) * 1.5;
    let h = landform(id, u, v) + roll + fine;

    if (kind === "woods") h += 0.6;
    if (kind === "rough") h += 1.4;
    return h;
  });

  // Set a datum before anything is cut.
  //
  // `landform` is a sum of ridges and knolls with no defined zero, so the
  // absolute height of a map was whatever the terms happened to add up to. On
  // the village map that put 1196 of 2240 tiles under the waterline, and the
  // river — which is one flat plane at WATER_LEVEL_M — spread over all of
  // them. Shift the field so the lowest piece of dry ground stands just clear
  // of the water; every other height is relative anyway.
  let floor = Infinity;
  for (let i = 0; i < raw.length; i += 1) {
    if (tiles[i] === "water") continue;
    floor = Math.min(floor, raw[i] ?? 0);
  }
  const datum = Number.isFinite(floor) ? WATER_LEVEL_M + BANK_CLEARANCE_M - floor : 0;
  const level = raw.map((h) => h + datum);

  // Water cuts a bed below whatever it runs through, and the banks either side
  // are drawn down to meet it — otherwise a stream sits in a wall.
  return level.map((h, i) => {
    const x = i % width;
    const y = Math.floor(i / width);
    const kind = tiles[i];
    if (kind === "water") return Math.min(WATER_LEVEL_M - MIN_DEPTH_M, h - 2.4);
    if (kind === "building") {
      // Level the ground a house stands on: average the pad around it.
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const j = (y + dy) * width + (x + dx);
          if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
          sum += level[j] ?? h;
          n += 1;
        }
      }
      return n ? sum / n : h;
    }
    if (kind === "road") {
      // A road is graded: pull it toward the mean of its neighbours so it does
      // not ride every bump the field has.
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const j = (y + dy) * width + (x + dx);
          if (x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
          sum += level[j] ?? h;
          n += 1;
        }
      }
      return n ? h * 0.35 + (sum / n) * 0.65 : h;
    }
    if (wet(tiles, width, height, x, y)) return h - 0.8;
    return h;
  });
};

/**
 * Clear a yard.
 *
 * A base needs ground it can actually stand on and a hard surface around it,
 * so its footprint plus a one-tile apron is forced to road. Without this a
 * depot authored on a nice-looking spot can land in a hedge and be
 * permanently uncapturable.
 */
const settle = (tiles: Terrain[], width: number, height: number, cell: Cell, span: number) => {
  for (let dy = -1; dy <= span; dy += 1) {
    for (let dx = -1; dx <= span; dx += 1) {
      const x = cell.x + dx;
      const y = cell.y + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      tiles[y * width + x] = dx >= 0 && dy >= 0 && dx < span && dy < span ? "road" : "open";
    }
  }
};

const make = (
  id: MapId,
  name: string,
  job: string,
  width: number,
  height: number,
  decorate: (tiles: Terrain[]) => void,
  features: WorldMap["features"],
  depotCells: Cell[],
): WorldMap => {
  const tiles = Array.from({ length: width * height }, () => "open" as Terrain);
  decorate(tiles);
  const playerZone = { x0: 1, x1: Math.max(3, Math.floor(width * 0.22)), y0: 2, y1: height - 3 };
  const enemyZone = { x0: Math.floor(width * 0.78), x1: width - 2, y0: 2, y1: height - 3 };
  const mainCells: Record<Side, Cell> = {
    // Set in from the edge, so a battalion can form line either side of the
    // gate without half of it standing off the map.
    player: { x: playerZone.x0 + 3, y: Math.floor(height / 2) - 1 },
    enemy: { x: enemyZone.x1 - 3, y: Math.floor(height / 2) - 1 },
  };
  settle(tiles, width, height, mainCells.player, 2);
  settle(tiles, width, height, mainCells.enemy, 2);
  for (const depot of depotCells) settle(tiles, width, height, depot, 1);
  return {
    id,
    name,
    job,
    width,
    height,
    tiles,
    heights: sculpt(id, width, height, tiles),
    playerZone,
    enemyZone,
    features,
    mainCells,
    depotCells,
  };
};

export const MAPS: Record<MapId, WorldMap> = {
  plain: make(
    "plain",
    "The Open Plain",
    "Cavalry and wide lines matter.",
    64,
    42,
    (tiles) => {
      // A lane that wanders down the length of the field, a copse either side
      // of it, and two patches of broken ground worth going round.
      track(tiles, 64, [[-2, 21], [18, 19], [34, 22], [48, 19], [66, 21]], 0.55, "road", 3.1, 0.8);
      hedge(tiles, 64, [[8, 26], [28, 27], [28, 36]], 41.1);
      hedge(tiles, 64, [[40, 6], [40, 15]], 44.6);
      copse(tiles, 64, 20, 10, 5.4, 3.6, "woods", 1.7);
      copse(tiles, 64, 47, 30, 6.2, 4.1, "rough", 5.3);
      copse(tiles, 64, 11, 32, 4.2, 3.0, "rough", 8.9);
    },
    { road: [{ x: 32, y: 20 }] },
    // The lane crossing, the copse, and the two patches of broken ground: the
    // four places on an open plain worth walking to.
    [{ x: 32, y: 20 }, { x: 20, y: 10 }, { x: 47, y: 30 }, { x: 11, y: 32 }, { x: 32, y: 34 }, { x: 32, y: 6 }],
  ),
  ridge: make(
    "ridge",
    "Broken Ridge",
    "Cavalry is punished; artillery and spacing matter.",
    56,
    40,
    (tiles) => {
      // Broken ground along both crests — the reason cavalry is punished here
      // — rather than a cross of rectangles laid over the whole map.
      for (let i = 0; i < 7; i += 1) {
        copse(tiles, 56, 3 + i * 8.6, 17 + Math.sin(i * 1.3) * 1.8, 4.6, 2.6, "rough", i * 2.7);
      }
      for (let i = 0; i < 4; i += 1) {
        copse(tiles, 56, 7 + i * 14, 31 + Math.cos(i * 1.7) * 1.4, 4.0, 2.2, "rough", 40 + i * 3.3);
      }
      copse(tiles, 56, 22, 6, 4.4, 3.2, "woods", 61.2);
      track(tiles, 56, [[-2, 20], [16, 18], [30, 21], [44, 18], [58, 20]], 0.9, "road", 11.4, 0.7);
    },
    { crest: [{ x: 28, y: 20 }] },
    // The crest itself, both shoulders, and the two saddles behind it.
    [{ x: 28, y: 20 }, { x: 14, y: 20 }, { x: 42, y: 20 }, { x: 28, y: 7 }, { x: 28, y: 33 }],
  ),
  longfield: make(
    "longfield",
    "Long Field",
    "Powder quality and artillery range are the purchase.",
    80,
    32,
    (tiles) => {
      track(tiles, 80, [[-2, 16], [22, 14], [44, 17], [62, 14], [82, 16]], 1.0, "road", 21.5, 0.8);
      hedge(tiles, 80, [[16, 22], [40, 23], [40, 30]], 51.3);
      hedge(tiles, 80, [[52, 4], [52, 11]], 55.9);
      copse(tiles, 80, 38, 6, 5.0, 3.4, "woods", 2.9);
      copse(tiles, 80, 63, 26, 5.6, 3.2, "woods", 13.1);
      copse(tiles, 80, 14, 27, 4.0, 2.4, "rough", 33.7);
    },
    { lane: [{ x: 40, y: 16 }] },
    // Strung along the road, because on a long field the road is the map.
    [{ x: 40, y: 16 }, { x: 22, y: 14 }, { x: 62, y: 14 }, { x: 40, y: 27 }, { x: 40, y: 5 }],
  ),
  village: make(
    "village",
    "The Village Lane",
    "Bindings, facing, and artillery placement matter.",
    56,
    40,
    (tiles) => {
      // A stream meandering across the south, the lane running the length of
      // the field, and the hamlet strung along it plot by plot.
      track(tiles, 56, [[-2, 37], [14, 38], [28, 36], [42, 38], [58, 37]], 1.5, "water", 7.7, 1.8);
      track(tiles, 56, [[-2, 20], [15, 18], [30, 21], [44, 19], [58, 20]], 0.5, "road", 4.3, 0.7);
      hamlet(tiles, 56, [[20, 19], [37, 20]], 14, "building", 6.1);
      // A back lane serving the plots behind the street.
      track(tiles, 56, [[24, 16], [30, 15], [35, 17]], 0.4, "road", 19.9, 0.5);
      // Hedged enclosures. Northern European fields are bounded, and a hedge
      // is ground a formation has to go round or lose its order in.
      hedge(tiles, 56, [[4, 26], [20, 27], [20, 34]], 21.4);
      hedge(tiles, 56, [[44, 10], [44, 22], [52, 24]], 27.8);
      hedge(tiles, 56, [[6, 12], [6, 18]], 31.2);
      copse(tiles, 56, 22, 8, 6.2, 4.0, "woods", 1.3);
      copse(tiles, 56, 38, 29, 5.0, 3.4, "woods", 9.4);
      copse(tiles, 56, 10, 9, 3.0, 2.0, "rough", 15.2);
    },
    {
      village: [{ x: 27, y: 18 }, { x: 28, y: 21 }],
      woods: [{ x: 22, y: 8 }],
      approach: [{ x: 16, y: 19 }],
    },
    // The hamlet, the mill by the ford, the wood, and the two enclosures.
    [{ x: 28, y: 20 }, { x: 28, y: 35 }, { x: 22, y: 9 }, { x: 44, y: 26 }, { x: 12, y: 26 }],
  ),
};

export const mapById = (id: MapId) => MAPS[id];
