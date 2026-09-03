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

/**
 * Feature noise is sampled in design space, not tile space.
 *
 * Every painter wobbles its outline with value noise keyed on the tile it is
 * drawing. Multiply a composition up and that keyed noise changes completely,
 * so a ford authored to cross a stream at one size misses the channel at
 * another -- and an army stands on the bank for the rest of the battle.
 * Dividing every sample by the linear factor makes a feature the same shape at
 * every size, only larger. Set at the top of `make`, which runs one field at a
 * time.
 */
let GRAIN = 1;

const put = (tiles: Terrain[], width: number, height: number, x: number, y: number, kind: Terrain) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  tiles[y * width + x] = kind;
};

/**
 * Masonry, which is the only thing here that is a wall.
 *
 * A house is never allowed onto a road. Plots were being laid over the lane
 * they were strung along, which walls the street off, and a formation that
 * walks into the resulting pocket wedges in it -- its centre ends up standing
 * inside the masonry and it never gets out. Villages grow *beside* their road.
 */
const build = (tiles: Terrain[], width: number, height: number, x: number, y: number, kind: Terrain) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  if (tiles[y * width + x] === "road") return;
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
      const edge = 1 + (vnoise((x * 0.24) / GRAIN + seed, (y * 0.24) / GRAIN - seed) - 0.5) * ragged;
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
      const drift = (vnoise((cx * 0.09) / GRAIN + seed, (cy * 0.09) / GRAIN + seed) - 0.5) * 2 * wander;
      cx += nx * drift;
      cy += ny * drift;
      const w = half * (0.78 + vnoise((cx * 0.3) / GRAIN - seed, (cy * 0.3) / GRAIN + seed) * 0.5);
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
        build(tiles, width, height, Math.round(cx) + dx, Math.round(cy) + dy, kind);
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
    const steps = Math.max(2, Math.ceil((span * 2) / GRAIN));
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

/**
 * A walled farm: a courtyard with a ring of buildings round it and a gate on
 * one side. These are the anchors of a Napoleonic field -- a battalion that
 * gets inside one is very hard to shift -- and they read on the map as a
 * single deliberate object rather than another patch of scatter.
 */
const steading = (
  tiles: Terrain[],
  width: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  gate: "n" | "s" | "e" | "w",
  seed = 0,
) => {
  const height = tiles.length / width;
  for (let y = cy - ry; y <= cy + ry; y += 1) {
    for (let x = cx - rx; x <= cx + rx; x += 1) {
      const edge = x === cx - rx || x === cx + rx || y === cy - ry || y === cy + ry;
      if (!edge) {
        put(tiles, width, height, x, y, "road");
        continue;
      }
      // The gateway, and the odd gap where a wall has come down.
      const atGate = (gate === "n" && y === cy - ry && Math.abs(x - cx) < 1.5)
        || (gate === "s" && y === cy + ry && Math.abs(x - cx) < 1.5)
        || (gate === "w" && x === cx - rx && Math.abs(y - cy) < 1.5)
        || (gate === "e" && x === cx + rx && Math.abs(y - cy) < 1.5);
      if (atGate) {
        put(tiles, width, height, x, y, "road");
        continue;
      }
      build(tiles, width, height, x, y, vnoise((x * 0.8) / GRAIN + seed, (y * 0.8) / GRAIN - seed) > 0.86 ? "rough" : "building");
    }
  }
};

/**
 * An orchard: trees in rows, which is what tells an orchard from a wood at a
 * glance. Cover for infantry, and a formation loses its dressing crossing it.
 */
const orchard = (
  tiles: Terrain[],
  width: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed = 0,
) => {
  const height = tiles.length / width;
  for (let y = Math.round(cy - ry); y <= Math.round(cy + ry); y += 1) {
    for (let x = Math.round(cx - rx); x <= Math.round(cx + rx); x += 1) {
      if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 > 1) continue;
      // Rows two apart, with the odd tree missing.
      if ((y - Math.round(cy - ry)) % 2 !== 0) continue;
      if (vnoise((x * 0.9) / GRAIN + seed, (y * 0.9) / GRAIN + seed) < 0.28) continue;
      put(tiles, width, height, x, y, "woods");
    }
  }
};

/**
 * Marsh: broken, wet going with standing water in it. Passable, slowly, and
 * ruinous to guns -- which is the whole point of a causeway.
 */
const marsh = (
  tiles: Terrain[],
  width: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  seed = 0,
) => {
  const height = tiles.length / width;
  for (let y = Math.round(cy - ry); y <= Math.round(cy + ry); y += 1) {
    for (let x = Math.round(cx - rx); x <= Math.round(cx + rx); x += 1) {
      const r2 = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      const edge = 1 + (vnoise((x * 0.2) / GRAIN + seed, (y * 0.2) / GRAIN - seed) - 0.5) * 0.9;
      if (r2 > edge) continue;
      if (tiles[y * width + x] === "road") continue;
      const pool = vnoise((x * 0.42) / GRAIN - seed, (y * 0.42) / GRAIN + seed);
      put(tiles, width, height, x, y, pool > 0.72 ? "water" : "rough");
    }
  }
};

/** A gaussian ridge along a line, in normalised map space. */
const ridgeAt = (u: number, v: number, axis: "u" | "v", at: number, width: number, crest: number) => {
  const d = (axis === "v" ? v : u) - at;
  return Math.exp(-((d / width) ** 2)) * crest;
};

/**
 * A ridge on any bearing: distance is measured to a line through (cu, cv) with
 * unit normal (nu, nv), so a crest can run across a field diagonally instead
 * of only north-south or east-west.
 */
const ridgeLine = (
  u: number, v: number,
  cu: number, cv: number,
  nu: number, nv: number,
  width: number, crest: number,
) => {
  const d = (u - cu) * nu + (v - cv) * nv;
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
    // A crest running north-west to south-east, athwart an advance that comes
    // up from the south-west, with a genuine hollow behind it: ground a
    // battalion can shelter in and a battery cannot see into.
    const NU = 0.707;
    const NV = 0.707;
    return (
      ridgeLine(u, v, 0.5, 0.5, NU, NV, 0.12, 21)
      // The saddle: the crest is drawn down where the road crosses it.
      - knollAt(u, v, 0.5, 0.5, 0.09, 9)
      // The hollow, on the reverse slope.
      - knollAt(u, v, 0.66, 0.66, 0.13, 8)
      + ridgeLine(u, v, 0.18, 0.18, NU, NV, 0.1, 6)
      + knollAt(u, v, 0.84, 0.2, 0.11, 5)
    );
  }
  if (id === "plain") {
    // Open country with one thing standing over it: the mill knoll. Everything
    // else is swell and fall, enough to hide a squadron and no more.
    return (
      knollAt(u, v, 0.43, 0.27, 0.13, 17)
      + knollAt(u, v, 0.5, 0.72, 0.2, 4.5)
      + ridgeAt(u, v, "u", 0.78, 0.2, 4)
      - knollAt(u, v, 0.2, 0.62, 0.15, 2.5)
    );
  }
  if (id === "longfield") {
    // A valley cut down the middle for the river, the ground rising away from
    // it on both banks, and low swells along the length.
    return (
      Math.sin(v * Math.PI * 2.6) * 3.2
      - ridgeAt(u, v, "u", 0.5, 0.1, 11)
      + ridgeAt(u, v, "u", 0.18, 0.13, 7)
      + ridgeAt(u, v, "u", 0.82, 0.13, 7)
      + knollAt(u, v, 0.3, 0.24, 0.1, 5)
      + knollAt(u, v, 0.7, 0.78, 0.1, 5)
    );
  }
  // Marchbourne: a ridge across the north the enemy comes over, the village
  // in the saddle below it, and the ground falling south to the stream.
  return (
    ridgeAt(u, v, "v", 0.18, 0.1, 16)
    + knollAt(u, v, 0.78, 0.3, 0.1, 7)
    + knollAt(u, v, 0.18, 0.36, 0.11, 6)
    - knollAt(u, v, 0.5, 0.52, 0.14, 3)
    - ridgeAt(u, v, "v", 0.76, 0.13, 6)
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
      //
      // Over five tiles rather than three. A terrace of houses on a slope,
      // each levelled against its own three-tile pad, ends up stepped -- the
      // outer ones sit more than a metre off the ground their neighbours
      // stand on. A wider window follows the local plane instead.
      let sum = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
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

/**
 * How much ground a field covers, as a multiple of the design grid.
 *
 * The compositions below are authored once, at the size that is comfortable to
 * lay out by hand, and then stood up at whatever scale the match asks for.
 * Positions multiply by the linear factor, feature sizes by a gentler one (a
 * wood is a wood; a bigger field simply holds more of them), and `fill`
 * scatters the additional country the extra ground needs so that five times
 * the field is not five times as empty.
 */
export const FIELD_SIZES = [
  { area: 1, name: "Compact", blurb: "The design grid. A single engagement." },
  { area: 2, name: "Standard", blurb: "Room for a flank march." },
  { area: 5, name: "Grand", blurb: "A day's battle. Roads start to matter." },
] as const;

export const DEFAULT_FIELD_AREA = 2;

const sizeOf = (area: number) => {
  const linear = Math.sqrt(Math.max(1, area));
  return { linear, swell: Math.max(1, Math.sqrt(linear)) };
};

/**
 * The brush a field is painted with.
 *
 * Every coordinate handed to it is in design units. Nothing below needs to
 * know the real size of the field, which is the point: the composition is
 * authored once and the scale is one number.
 */
type Brush = {
  /** A metalled road, lane or track. */
  road(through: Array<[number, number]>, half: number, seed: number, wander?: number): void;
  /** A watercourse. */
  water(through: Array<[number, number]>, half: number, seed: number, wander?: number): void;
  /** A wood, or a patch of broken going. */
  patch(cx: number, cy: number, rx: number, ry: number, kind: Terrain, seed: number): void;
  /** Trees in rows. */
  orchard(cx: number, cy: number, rx: number, ry: number, seed: number): void;
  /** Wet, broken ground with standing water in it. */
  marsh(cx: number, cy: number, rx: number, ry: number, seed: number): void;
  /** Plots strung along a lane. */
  hamlet(through: Array<[number, number]>, plots: number, seed: number): void;
  /** A walled farm with a gate. */
  steading(cx: number, cy: number, rx: number, ry: number, gate: "n" | "s" | "e" | "w", seed: number): void;
  /** A field boundary. */
  hedge(through: Array<[number, number]>, seed: number): void;
  /**
   * Scatter country across a box in design units, deterministically. This is
   * what keeps a two-kilometre field from being a green desert with four
   * copses on it.
   */
  fill(
    box: [number, number, number, number],
    kinds: ReadonlyArray<Terrain | "orchard" | "hedge">,
    count: number,
    seed: number,
  ): void;
};

const brushFor = (tiles: Terrain[], width: number, area: number): Brush => {
  const { linear, swell } = sizeOf(area);
  const at = (n: number) => n * linear;
  const sz = (n: number) => n * swell;
  const line = (through: Array<[number, number]>): Array<[number, number]> =>
    through.map(([x, y]) => [at(x), at(y)]);
  const self: Brush = {
    road: (through, half, seed, wander = 1.2) =>
      track(tiles, width, line(through), half * Math.max(1, swell * 0.75), "road", seed, wander * swell),
    water: (through, half, seed, wander = 1.8) =>
      track(tiles, width, line(through), half * Math.max(1, swell * 0.9), "water", seed, wander * swell),
    patch: (cx, cy, rx, ry, kind, seed) =>
      copse(tiles, width, at(cx), at(cy), sz(rx), sz(ry), kind, seed),
    orchard: (cx, cy, rx, ry, seed) => orchard(tiles, width, at(cx), at(cy), sz(rx), sz(ry), seed),
    marsh: (cx, cy, rx, ry, seed) => marsh(tiles, width, at(cx), at(cy), at(rx), at(ry), seed),
    hamlet: (through, plots, seed) =>
      hamlet(tiles, width, line(through), Math.round(plots * linear), "building", seed),
    steading: (cx, cy, rx, ry, gate, seed) =>
      steading(tiles, width, Math.round(at(cx)), Math.round(at(cy)),
        Math.round(sz(rx)), Math.round(sz(ry)), gate, seed),
    hedge: (through, seed) => hedge(tiles, width, line(through), seed),
    fill: ([x0, y0, x1, y1], kinds, count, seed) => {
      // Scale the amount of scattered country with the ground, not the
      // composition: the authored features are the field's bones and stay put.
      const many = Math.round(count * (area - 1) * 0.34);
      for (let i = 0; i < many; i += 1) {
        const a = vnoise(i * 1.7 + seed, i * 0.31 - seed);
        const b = vnoise(i * 0.53 - seed, i * 2.11 + seed);
        const c = vnoise(i * 3.7 + seed, i * 1.13 + seed);
        const cx = x0 + (x1 - x0) * a;
        const cy = y0 + (y1 - y0) * b;
        const kind = kinds[Math.floor(c * kinds.length) % kinds.length] ?? "woods";
        const rx = 2.2 + c * 3.4;
        const ry = 1.5 + a * 2.4;
        if (kind === "hedge") {
          const run = 6 + b * 10;
          const turn = c > 0.5;
          self.hedge(turn
            ? [[cx, cy], [cx + run, cy + 1], [cx + run, cy + run * 0.6]]
            : [[cx, cy], [cx + 1, cy + run]], seed + i * 7.3);
          continue;
        }
        if (kind === "orchard") {
          self.orchard(cx, cy, rx * 0.8, ry * 0.8, seed + i * 5.1);
          continue;
        }
        self.patch(cx, cy, rx, ry, kind, seed + i * 3.9);
      }
    },
  };
  return self;
};

/**
 * Compose a field.
 *
 * The two headquarters are placed by hand rather than derived from the map's
 * width, because the axis of a battle is a design decision: one of these is
 * fought across, one along, and one from a corner. The deployment zone is the
 * ground behind each headquarters, squared off and clipped to the field.
 */
type Design = {
  id: MapId;
  name: string;
  designW: number;
  designH: number;
  starts: Record<Side, [number, number]>;
  decorate: (brush: Brush) => void;
  features: Record<string, Array<[number, number]>>;
  depots: Array<[number, number]>;
  /** Extra depots, taken in order as the field grows. */
  spare?: Array<[number, number]>;
};

const make = ({
  id, name, designW, designH, starts, decorate, features, depots, spare = [],
}: Design, area: number): WorldMap => {
  const { linear } = sizeOf(area);
  const width = Math.round(designW * linear);
  const height = Math.round(designH * linear);
  const grid = (pair: [number, number]): Cell => ({
    x: Math.min(width - 3, Math.max(2, Math.round(pair[0] * linear))),
    y: Math.min(height - 3, Math.max(2, Math.round(pair[1] * linear))),
  });
  GRAIN = linear;
  const tiles = Array.from({ length: width * height }, () => "open" as Terrain);
  decorate(brushFor(tiles, width, area));
  const zone = (at: Cell) => ({
    x0: Math.max(1, at.x - Math.round(width * 0.1)),
    x1: Math.min(width - 2, at.x + Math.round(width * 0.1)),
    y0: Math.max(1, at.y - Math.round(height * 0.22)),
    y1: Math.min(height - 2, at.y + Math.round(height * 0.22)),
  });
  const mainCells: Record<Side, Cell> = { player: grid(starts.player), enemy: grid(starts.enemy) };
  // More ground wants more worth taking, or a big field is a long walk to the
  // same five depots.
  const extra = Math.min(spare.length, Math.round((area - 1) * 1.4));
  const depotCells = [...depots, ...spare.slice(0, extra)].map(grid);
  const yard = area >= 5 ? 3 : 2;
  settle(tiles, width, height, mainCells.player, yard + 1);
  settle(tiles, width, height, mainCells.enemy, yard + 1);
  for (const depot of depotCells) settle(tiles, width, height, depot, yard);
  return {
    id,
    name,
    width,
    height,
    tiles,
    area,
    heights: sculpt(id, width, height, tiles),
    playerZone: zone(mainCells.player),
    enemyZone: zone(mainCells.enemy),
    features: Object.fromEntries(
      Object.entries(features).map(([key, list]) => [key, list.map(grid)]),
    ),
    mainCells,
    depotCells,
  };
};

/**
 * The fields.
 *
 * Four of them, and deliberately not four versions of the same field. Each has
 * its own axis, its own shape of ground, and one question it asks of the
 * player: can you take open high ground under cavalry; can you get over a
 * crest that has one gate; which of three crossings do you force; and can you
 * fight through enclosed country where your horse is no use to you.
 *
 * All authored by hand and deterministic, so the same field always comes up
 * the same way and can be learned.
 */
const DESIGNS: Record<MapId, Design> = {
  /**
   * Windmill Plain. Fought east to west across open country, over the one
   * piece of high ground on it. Cavalry country: the ground is open enough
   * that a formation caught out of square is in real trouble.
   */
  plain: {
    id: "plain",
    name: "Windmill Plain",
    designW: 88,
    designH: 60,
    starts: { player: [8, 30], enemy: [80, 30] },
    decorate: (b) => {
      b.road([[-2, 33], [20, 31], [42, 34], [62, 30], [90, 32]], 0.6, 3.1, 1.1);
      b.road([[41, 33], [39, 24], [40, 16], [44, 4]], 0.45, 17.2, 0.8);
      // The sunken lane: a covered diagonal from the south-west to the north-east.
      b.road([[16, 52], [34, 40], [52, 26], [70, 14]], 0.5, 26.4, 1.4);
      // Two lateral roads, because a field this size needs a way across it.
      b.road([[6, 14], [30, 12], [56, 15], [82, 12]], 0.4, 31.7, 1.0);
      b.road([[6, 50], [30, 52], [56, 49], [82, 52]], 0.4, 35.2, 1.0);

      b.hamlet([[36, 15], [43, 18]], 5, 8.3);
      b.hamlet([[62, 50], [70, 52]], 4, 61.4);
      // La Grange: the walled farm south of the road, the anchor of that flank.
      b.steading(47, 45, 4, 3, "n", 12.7);
      b.steading(20, 40, 3, 3, "e", 66.8);

      b.patch(17, 13, 6.4, 4.2, "woods", 1.7);
      b.patch(68, 21, 7.0, 4.6, "woods", 5.3);
      b.patch(30, 51, 5.2, 3.4, "woods", 9.1);
      b.patch(62, 49, 6.0, 3.8, "rough", 14.6);
      b.patch(10, 44, 4.6, 3.2, "rough", 19.2);
      b.patch(78, 44, 4.2, 3.0, "rough", 23.8);
      b.orchard(51, 39, 5.0, 3.0, 28.1);

      b.hedge([[24, 38], [38, 39], [38, 48]], 41.1);
      b.hedge([[54, 8], [54, 18], [64, 20]], 44.6);
      b.hedge([[12, 22], [24, 23]], 47.9);
      b.hedge([[66, 36], [78, 37], [78, 30]], 51.4);

      // The rest of the country: open plain wants enclosures and copses, not
      // woodland, or the cavalry has nowhere to work.
      b.fill([6, 4, 82, 56], ["hedge", "rough", "woods", "hedge", "orchard"], 46, 91.3);
    },
    features: { knoll: [[40, 17]], crossroads: [[44, 33]], farm: [[47, 45]] },
    depots: [[40, 18], [44, 33], [47, 45], [68, 21], [18, 14], [30, 51], [70, 47]],
    spare: [[24, 26], [58, 38], [12, 36], [76, 16]],
  },

  /**
   * Hollow Ridge. Fought from the south-west corner to the north-east, so the
   * whole advance is diagonal and the crest sits square across it. The road
   * crosses at one saddle; everything else is a climb through broken ground.
   * Behind the crest is dead ground a battery cannot see into.
   */
  ridge: {
    id: "ridge",
    name: "Hollow Ridge",
    designW: 76,
    designH: 64,
    starts: { player: [9, 54], enemy: [66, 8] },
    decorate: (b) => {
      b.road([[4, 60], [20, 48], [33, 38], [40, 30], [52, 20], [70, 6]], 0.55, 7.4, 1.2);
      b.road([[22, 26], [40, 34], [58, 44]], 0.4, 13.9, 1.0);
      b.road([[6, 34], [22, 44], [38, 54], [56, 60]], 0.35, 88.2, 1.0);
      b.road([[20, 4], [38, 12], [54, 8], [70, 20]], 0.35, 92.6, 1.0);

      // Broken ground the length of the crest, thinned at the saddle so there
      // is exactly one place a gun team can be got over.
      for (let i = 0; i < 13; i += 1) {
        const t = i / 12;
        const cx = 6 + t * 62;
        const cy = 58 - t * 52;
        if (Math.abs(cx - 40) < 6 && Math.abs(cy - 30) < 6) continue;
        b.patch(cx, cy, 4.2, 3.0, "rough", 3 + i * 2.7);
      }
      b.patch(22, 14, 8.0, 5.4, "woods", 31.2);
      b.patch(12, 30, 5.2, 4.0, "woods", 35.8);
      b.patch(60, 54, 7.0, 4.6, "woods", 39.4);
      b.patch(66, 30, 5.0, 3.6, "rough", 43.1);

      b.steading(50, 42, 3, 3, "w", 46.5);
      b.steading(30, 22, 3, 2, "s", 96.1);
      b.hamlet([[14, 46], [22, 50]], 4, 99.4);
      b.hedge([[16, 44], [28, 50], [40, 52]], 51.7);
      b.hedge([[46, 8], [58, 12], [60, 22]], 55.3);
      b.hedge([[8, 20], [8, 30]], 58.8);

      b.fill([5, 4, 71, 60], ["woods", "rough", "hedge", "woods", "orchard"], 44, 103.7);
    },
    features: { saddle: [[40, 30]], hollow: [[50, 42]], crest: [[26, 44]] },
    depots: [[40, 30], [50, 42], [26, 43], [55, 18], [20, 16], [60, 55], [14, 38]],
    spare: [[34, 52], [46, 12], [66, 40]],
  },

  /**
   * The Causeway. A long field with a river and its marshes across the middle
   * and three ways over: a stone bridge in the north, a ford in the centre,
   * and a raised causeway in the south. Which one you force is the battle.
   */
  longfield: {
    id: "longfield",
    name: "The Causeway",
    designW: 100,
    designH: 46,
    starts: { player: [8, 22], enemy: [91, 22] },
    decorate: (b) => {
      b.road([[-2, 24], [22, 21], [38, 25], [44, 23]], 0.6, 2.4, 1.0);
      b.road([[57, 23], [66, 26], [82, 21], [102, 24]], 0.6, 4.8, 1.0);
      b.road([[42, 6], [44, 20], [42, 34], [44, 42]], 0.45, 9.2, 0.8);
      b.road([[58, 6], [56, 20], [58, 34], [56, 42]], 0.45, 11.6, 0.8);
      b.road([[6, 8], [26, 6], [34, 10]], 0.35, 79.1, 0.9);
      b.road([[6, 38], [26, 40], [34, 36]], 0.35, 82.4, 0.9);
      b.road([[66, 8], [86, 6], [94, 10]], 0.35, 85.8, 0.9);
      b.road([[66, 38], [86, 40], [94, 36]], 0.35, 89.2, 0.9);

      b.water([[47, -2], [51, 12], [48, 24], [52, 36], [49, 48]], 1.7, 15.3, 2.2);
      b.marsh(50, 12, 9, 9, 18.7);
      b.marsh(50, 34, 9, 9, 22.1);

      // Three crossings, laid over the water after it, and wide enough to pass
      // a formation: a one-tile gap is a path on paper and a wall in practice.
      b.road([[42, 8], [50, 9], [58, 8]], 2.0, 25.4, 0.4);
      b.road([[44, 23], [50, 24], [56, 23]], 2.4, 28.9, 0.3);
      b.road([[42, 37], [50, 38], [58, 37]], 2.2, 32.2, 0.35);

      b.hamlet([[38, 6], [44, 11]], 7, 36.1);
      b.hamlet([[76, 26], [84, 30]], 5, 93.4);
      b.steading(61, 38, 3, 2, "w", 39.5);
      b.steading(20, 16, 3, 3, "s", 96.7);

      b.patch(28, 8, 5.2, 3.6, "woods", 43.2);
      b.patch(68, 12, 7.0, 4.4, "woods", 46.8);
      b.patch(24, 36, 6.0, 3.8, "woods", 50.3);
      b.patch(76, 34, 6.6, 4.0, "rough", 53.9);
      b.patch(14, 14, 4.6, 3.2, "rough", 57.4);
      b.patch(88, 12, 4.4, 3.0, "rough", 61.1);
      b.orchard(36, 16, 5.0, 3.4, 64.6);
      b.orchard(66, 30, 5.0, 3.4, 68.2);

      b.hedge([[20, 28], [34, 30], [34, 40]], 71.5);
      b.hedge([[70, 16], [84, 15], [84, 8]], 75.1);

      // Nothing scattered over the marsh belt: the crossings are the point.
      b.fill([5, 3, 40, 43], ["hedge", "woods", "orchard", "rough"], 24, 107.2);
      b.fill([60, 3, 95, 43], ["hedge", "woods", "orchard", "rough"], 24, 111.6);
    },
    features: { bridge: [[50, 9]], ford: [[50, 24]], causeway: [[50, 38]] },
    depots: [[50, 9], [50, 24], [50, 38], [30, 22], [70, 22], [36, 6], [64, 40]],
    spare: [[16, 10], [16, 36], [84, 10], [84, 36]],
  },

  /**
   * Marchbourne. Fought from the south up to the north, through enclosed
   * country: the village along its street, orchards, hedged plots and a stream
   * with two fords. Horse is close to useless here and knows it.
   */
  village: {
    id: "village",
    name: "Marchbourne",
    designW: 72,
    designH: 66,
    starts: { player: [35, 58], enemy: [35, 7] },
    decorate: (b) => {
      b.road([[-2, 31], [18, 33], [36, 30], [54, 33], [74, 31]], 0.5, 4.3, 0.8);
      b.road([[34, 62], [36, 46], [34, 32], [37, 18], [35, 2]], 0.5, 8.7, 1.0);
      b.road([[26, 27], [34, 26], [44, 28]], 0.4, 12.1, 0.5);
      b.road([[8, 56], [10, 40], [8, 24], [12, 10]], 0.35, 85.3, 1.0);
      b.road([[62, 56], [60, 40], [62, 24], [58, 10]], 0.35, 88.7, 1.0);
      b.road([[6, 14], [24, 12], [46, 15], [66, 12]], 0.35, 92.1, 0.9);

      b.water([[-2, 48], [16, 50], [34, 47], [52, 50], [74, 48]], 1.3, 16.4, 1.8);
      b.road([[18, 44], [20, 50], [19, 55]], 2.2, 19.8, 0.3);
      b.road([[50, 44], [51, 50], [50, 55]], 2.2, 23.2, 0.3);

      b.hamlet([[24, 32], [48, 31]], 18, 26.7);
      b.hamlet([[10, 20], [16, 24]], 5, 95.6);
      b.hamlet([[54, 20], [60, 17]], 5, 98.9);
      b.steading(22, 29, 3, 2, "e", 30.4);
      b.steading(52, 34, 3, 3, "w", 34.1);
      b.steading(36, 42, 3, 2, "n", 102.3);

      b.orchard(30, 22, 6.0, 4.0, 37.5);
      b.orchard(46, 40, 5.4, 3.6, 41.2);
      b.orchard(14, 38, 4.6, 3.2, 44.8);

      b.patch(13, 18, 8.0, 5.6, "woods", 48.3);
      b.patch(58, 16, 6.6, 4.4, "woods", 51.9);
      b.patch(60, 54, 6.0, 4.0, "woods", 55.4);
      b.patch(8, 56, 5.0, 3.6, "rough", 59.1);
      b.patch(44, 8, 6.2, 4.2, "rough", 62.7);

      b.hedge([[8, 26], [22, 27], [22, 20]], 66.2);
      b.hedge([[42, 22], [42, 12], [54, 10]], 69.8);
      b.hedge([[10, 40], [26, 41], [26, 46]], 73.3);
      b.hedge([[46, 44], [62, 43], [62, 34]], 76.9);
      b.hedge([[6, 32], [6, 42]], 80.4);
      b.hedge([[64, 24], [64, 32]], 84.1);

      // Enclosed country, so the extra ground is hedge and orchard first.
      b.fill([4, 3, 68, 62], ["hedge", "hedge", "orchard", "woods", "rough"], 58, 115.4);
    },
    features: {
      village: [[34, 31]],
      church: [[22, 29]],
      fords: [[19, 50], [50, 50]],
    },
    depots: [[34, 31], [22, 29], [52, 34], [19, 50], [50, 50], [14, 19], [58, 17]],
    spare: [[36, 42], [8, 38], [62, 40], [34, 12]],
  },
};

/** Name and design proportions, for the setup screen. */
export const MAP_LIST = (Object.keys(DESIGNS) as MapId[]).map((id) => {
  const design = DESIGNS[id];
  return { id, name: design.name, ratio: design.designW / design.designH };
});

/**
 * Fields are built on demand and kept.
 *
 * A grand field is a quarter of a million tiles to paint; building all four at
 * every size when the module loads would cost seconds of start-up for three
 * maps nobody chose. The cache is keyed by field and size, so re-picking one
 * you have already seen is free.
 */
const built = new Map<string, WorldMap>();

export const mapById = (id: MapId, area = DEFAULT_FIELD_AREA) => {
  const key = `${id}@${area}`;
  const kept = built.get(key);
  if (kept) return kept;
  const map = make(DESIGNS[id], area);
  built.set(key, map);
  return map;
};
