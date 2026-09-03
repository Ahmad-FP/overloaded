import { terrainAt } from "../domain/terrain";
import type { Terrain, WorldMap } from "../domain/types";

/**
 * The painted board.
 *
 * Civ VI's map does not read well because of its polygon count; it reads well
 * because every tile is *illustrated* — a wood is drawn as canopies with
 * shadows under them, a village as roofs, a hill as shaded relief — and the
 * whole thing sits on a warm cartographic ground with ink at the edges. None
 * of that needs a GPU. This bakes the entire field once into an offscreen
 * canvas at a fixed 48 px per tile, and the view then pans and zooms a bitmap.
 *
 * Baking is the only expensive thing the renderer does and it happens once per
 * map, so it can afford to be per-pixel where per-pixel pays: relief shading,
 * mottle and the hypsometric wash. Everything above that is vector drawing.
 */

const BAKE_PX = 48;

const INK = "#3a2c1e";

/**
 * Warm cartography: saturated earth, never neon, never grey.
 *
 * Held as numeric triples, not hex strings. The ground pass runs five million
 * times per bake and a colour that has to be re-parsed at every step of the
 * blend is both slow and, as it turned out, easy to get wrong — a mix that
 * returns `rgb(...)` and only parses `#rrggbb` yields NaN on its own output,
 * and a Uint8ClampedArray stores NaN as zero without complaining.
 */
type RGB = readonly [number, number, number];

const rgb = (hex: string): RGB => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Flat tile colours, for the setup-screen map previews. */
export const PREVIEW_TONE: Record<Terrain, RGB> = {
  open: rgb("#93a659"),
  road: rgb("#cbaa76"),
  rough: rgb("#9a9a5b"),
  woods: rgb("#4f6b3b"),
  building: rgb("#a58a68"),
  water: rgb("#3a7c93"),
};

const PALETTE: Record<Terrain, { base: RGB; high: RGB; low: RGB }> = {
  open: { base: rgb("#93a659"), high: rgb("#b3c274"), low: rgb("#6d8142") },
  road: { base: rgb("#cbaa76"), high: rgb("#e0c493"), low: rgb("#a9884f") },
  rough: { base: rgb("#9a9a5b"), high: rgb("#b8b477"), low: rgb("#77773f") },
  woods: { base: rgb("#4f6b3b"), high: rgb("#6b8a4d"), low: rgb("#33452a") },
  building: { base: rgb("#a58a68"), high: rgb("#c4a682"), low: rgb("#7c6446") },
  water: { base: rgb("#3a7c93"), high: rgb("#59a2b5"), low: rgb("#1f4f66") },
};

const DRY = rgb("#c0b06a");
const DRY_ROUGH = rgb("#a89a63");
const LUSH = rgb("#5f7a4a");
/** Water at the bank, before it drops away. */
const SHALLOW = rgb("#7bb6b8");
/** Sunlit leaf, for the top of a canopy. */
const HIGHLIGHT = rgb("#c9dd93");

/**
 * Deterministic value hash, from a table.
 *
 * The ground pass runs five million times and asks for around twenty hashes
 * each; at that volume `Math.sin` is most of the bake. A 256x256 table filled
 * once from a cheap integer generator gives the same look for a fraction of
 * the time, and stays deterministic across runs.
 */
const HASH_BITS = 8;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const HASH_TABLE = (() => {
  const table = new Float32Array(HASH_SIZE * HASH_SIZE);
  let seed = 0x9e3779b9;
  for (let i = 0; i < table.length; i += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    table[i] = ((seed >>> 0) % 100000) / 100000;
  }
  return table;
})();

const hash = (x: number, y: number) => {
  const ix = Math.floor(x) & HASH_MASK;
  const iy = Math.floor(y) & HASH_MASK;
  return HASH_TABLE[(iy << HASH_BITS) | ix] ?? 0;
};

const valueNoise = (x: number, y: number) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
};

const heightAtTile = (map: WorldMap, tx: number, tz: number) => {
  const cx = (v: number) => Math.min(map.width - 1, Math.max(0, v));
  const cz = (v: number) => Math.min(map.height - 1, Math.max(0, v));
  const at = (ix: number, iz: number) => map.heights[cz(iz) * map.width + cx(ix)] ?? 0;
  const x0 = Math.floor(tx);
  const z0 = Math.floor(tz);
  const fx = tx - x0;
  const fz = tz - z0;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  return (
    at(x0, z0) * (1 - sx) * (1 - sz) +
    at(x0 + 1, z0) * sx * (1 - sz) +
    at(x0, z0 + 1) * (1 - sx) * sz +
    at(x0 + 1, z0 + 1) * sx * sz
  );
};

const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Roll the top of the range over instead of clipping it flat. */
const shoulder = (v: number) => (v <= 200 ? v : 200 + (255 - 200) * (1 - Math.exp((200 - v) / 40)));

const css = (colour: RGB) =>
  `rgb(${Math.round(colour[0])},${Math.round(colour[1])},${Math.round(colour[2])})`;

/** Relief, in the same north-west convention every printed map has used. */
const RELIEF_AZIMUTH = Math.PI * 1.25;
const RELIEF_ALTITUDE = Math.PI * 0.32;
const RELIEF_EXAGGERATION = 6.5;

/**
 * Relief, precomputed.
 *
 * The height field is one value per tile, so relief computed per bake pixel
 * invents detail that is not in the data and costs five million slope
 * evaluations to do it. Four samples per tile is past the point where the
 * eye can tell, and the pass then reads from a small table.
 */
const RELIEF_STEPS = 4;

type ReliefField = { w: number; h: number; lit: Float32Array; slope: Float32Array };

const reliefField = (map: WorldMap, metresPerTile: number): ReliefField => {
  const w = map.width * RELIEF_STEPS + 1;
  const h = map.height * RELIEF_STEPS + 1;
  const lit = new Float32Array(w * h);
  const slope = new Float32Array(w * h);
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) {
      const value = shade(map, i / RELIEF_STEPS, j / RELIEF_STEPS, metresPerTile);
      lit[j * w + i] = value.lit;
      slope[j * w + i] = value.slope;
    }
  }
  return { w, h, lit, slope };
};

const sampleRelief = (field: ReliefField, tx: number, tz: number) => {
  const fx = Math.min(field.w - 1.001, Math.max(0, tx * RELIEF_STEPS));
  const fz = Math.min(field.h - 1.001, Math.max(0, tz * RELIEF_STEPS));
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  const ax = fx - x0;
  const az = fz - z0;
  const i00 = z0 * field.w + x0;
  const i10 = i00 + 1;
  const i01 = i00 + field.w;
  const i11 = i01 + 1;
  const bilinear = (grid: Float32Array) =>
    ((grid[i00] ?? 0) * (1 - ax) + (grid[i10] ?? 0) * ax) * (1 - az) +
    ((grid[i01] ?? 0) * (1 - ax) + (grid[i11] ?? 0) * ax) * az;
  return { lit: bilinear(field.lit), slope: bilinear(field.slope) };
};

const shade = (map: WorldMap, tx: number, tz: number, metresPerTile: number) => {
  const d = 0.5;
  const dzdx = (heightAtTile(map, tx + d, tz) - heightAtTile(map, tx - d, tz)) / (2 * d * metresPerTile);
  const dzdz = (heightAtTile(map, tx, tz + d) - heightAtTile(map, tx, tz - d)) / (2 * d * metresPerTile);
  const slope = Math.atan(RELIEF_EXAGGERATION * Math.hypot(dzdx, dzdz));
  const aspect = Math.atan2(dzdz, -dzdx);
  const lit = Math.cos(RELIEF_ALTITUDE) * Math.cos(slope) +
    Math.sin(RELIEF_ALTITUDE) * Math.sin(slope) * Math.cos(RELIEF_AZIMUTH - aspect);
  return { lit: Math.max(0, Math.min(1, lit)), slope };
};

/**
 * Enclosed fields.
 *
 * An open plain rendered as one colour reads as a bug however good the noise
 * on top of it is, because real farmland is not one colour — it is a quilt of
 * parcels, each ploughed in its own direction and fenced from its neighbour.
 * A jittered Worley grid gives the parcels; the boundaries between them give
 * the hedgerows; the parcel's own angle gives the furrows. Computed once per
 * tile, so the per-pixel pass only does a lookup.
 */
const PARCEL_TILES = 4.4;

type Parcel = { id: number; angle: number; tone: number; crop: number };

const parcelSite = (gx: number, gz: number) => ({
  x: (gx + 0.18 + hash(gx * 1.7, gz * 3.1) * 0.64) * PARCEL_TILES,
  z: (gz + 0.18 + hash(gx * 5.3, gz * 2.9) * 0.64) * PARCEL_TILES,
  id: (gx + 1024) * 4096 + (gz + 1024),
});

const parcelAt = (tx: number, tz: number): Parcel => {
  const gx = Math.floor(tx / PARCEL_TILES);
  const gz = Math.floor(tz / PARCEL_TILES);
  let best = Infinity;
  let id = 0;
  for (let j = -1; j <= 1; j += 1) {
    for (let i = -1; i <= 1; i += 1) {
      const site = parcelSite(gx + i, gz + j);
      const d = (site.x - tx) ** 2 + (site.z - tz) ** 2;
      if (d >= best) continue;
      best = d;
      id = site.id;
    }
  }
  const spin = hash(id % 733, Math.floor(id / 733));
  return {
    id,
    angle: spin * Math.PI,
    tone: hash(id % 197, Math.floor(id / 197)) - 0.5,
    crop: hash(id % 311, Math.floor(id / 311)),
  };
};

/** One parcel per tile centre, so the pixel pass and the hedges agree. */
const parcelField = (map: WorldMap) => {
  const out: Parcel[] = [];
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) out.push(parcelAt(x + 0.5, y + 0.5));
  }
  return out;
};

/** Farmland, in the colours a crop actually takes through a season. */
const CROPS: RGB[] = [
  rgb("#8fa457"), rgb("#a8ab5c"), rgb("#7f9a52"), rgb("#b6ab63"),
  rgb("#9db463"), rgb("#8a9c4d"), rgb("#c2b06b"),
];

type Sprite = { x: number; y: number; kind: Terrain; scale: number; tint: number };

/** Where the drawn features go, decided once so they never crawl between frames. */
const scatter = (map: WorldMap): Sprite[] => {
  const out: Sprite[] = [];
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const kind = terrainAt(map, x, y);
      if (kind === "woods") {
        const n = 3 + Math.floor(hash(x * 3.1, y * 7.7) * 3);
        for (let i = 0; i < n; i += 1) {
          out.push({
            x: x + 0.16 + hash(x * 13 + i, y * 5 + i * 3) * 0.68,
            y: y + 0.16 + hash(y * 17 + i * 2, x * 11 + i) * 0.68,
            kind,
            scale: 0.32 + hash(x + i, y - i) * 0.2,
            tint: hash(x * 2 + i, y * 3 + i),
          });
        }
      } else if (kind === "building") {
        out.push({
          x: x + 0.5,
          y: y + 0.5,
          kind,
          scale: 0.62 + hash(x * 5.3, y * 2.9) * 0.22,
          tint: hash(x * 7, y * 9),
        });
      } else if (kind === "rough") {
        const n = 2 + Math.floor(hash(x * 1.7, y * 4.3) * 3);
        for (let i = 0; i < n; i += 1) {
          out.push({
            x: x + 0.2 + hash(x * 9 + i, y * 3 + i) * 0.6,
            y: y + 0.2 + hash(y * 6 + i, x * 8 + i) * 0.6,
            kind,
            scale: 0.2 + hash(x - i, y + i) * 0.14,
            tint: hash(x + i * 3, y + i * 5),
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.y - b.y);
};

const drawTree = (ctx: CanvasRenderingContext2D, sprite: Sprite) => {
  const px = sprite.x * BAKE_PX;
  const py = sprite.y * BAKE_PX;
  const r = sprite.scale * BAKE_PX;
  ctx.fillStyle = "rgba(28,22,14,0.26)";
  ctx.beginPath();
  ctx.ellipse(px + r * 0.42, py + r * 0.5, r * 0.95, r * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#3b2c1c";
  ctx.fillRect(px - r * 0.09, py - r * 0.1, r * 0.18, r * 0.62);
  const canopy = mix(PALETTE.woods.low, PALETTE.woods.high, 0.25 + sprite.tint * 0.6);
  ctx.fillStyle = css(canopy);
  ctx.beginPath();
  ctx.arc(px - r * 0.34, py - r * 0.18, r * 0.56, 0, Math.PI * 2);
  ctx.arc(px + r * 0.32, py - r * 0.12, r * 0.5, 0, Math.PI * 2);
  ctx.arc(px, py - r * 0.62, r * 0.62, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = css(mix(canopy, HIGHLIGHT, 0.4));
  ctx.beginPath();
  ctx.arc(px - r * 0.16, py - r * 0.76, r * 0.3, 0, Math.PI * 2);
  ctx.fill();
};

const drawHouse = (ctx: CanvasRenderingContext2D, sprite: Sprite) => {
  const px = sprite.x * BAKE_PX;
  const py = sprite.y * BAKE_PX;
  const w = sprite.scale * BAKE_PX;
  const h = w * 0.62;
  const lean = sprite.tint > 0.5 ? 1 : -1;
  ctx.fillStyle = "rgba(28,22,14,0.3)";
  ctx.beginPath();
  ctx.ellipse(px + w * 0.3, py + h * 0.58, w * 0.78, h * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  // Wall
  ctx.fillStyle = sprite.tint > 0.62 ? "#d9cbb0" : "#c3b193";
  ctx.fillRect(px - w * 0.42, py - h * 0.05, w * 0.84, h * 0.62);
  ctx.fillStyle = "rgba(58,44,30,0.22)";
  ctx.fillRect(px + w * 0.16, py - h * 0.05, w * 0.26, h * 0.62);
  // Roof: a simple gable, the one shape that reads as "house" at 12 px.
  const roof = sprite.tint > 0.4 ? "#9c4a35" : "#8d6a45";
  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(px - w * 0.54, py - h * 0.02);
  ctx.lineTo(px, py - h * 0.72);
  ctx.lineTo(px + w * 0.54, py - h * 0.02);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(255,240,215,0.2)";
  ctx.beginPath();
  ctx.moveTo(px - w * 0.54, py - h * 0.02);
  ctx.lineTo(px, py - h * 0.72);
  ctx.lineTo(px - w * 0.06, py - h * 0.02);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#4a3a28";
  ctx.fillRect(px + lean * w * 0.22, py - h * 0.78, w * 0.11, h * 0.3);
};

const drawScrub = (ctx: CanvasRenderingContext2D, sprite: Sprite) => {
  const px = sprite.x * BAKE_PX;
  const py = sprite.y * BAKE_PX;
  const r = sprite.scale * BAKE_PX;
  ctx.strokeStyle = css(mix(PALETTE.rough.low, PALETTE.rough.high, sprite.tint));
  ctx.lineWidth = Math.max(1, r * 0.22);
  ctx.lineCap = "round";
  for (let i = -1; i <= 1; i += 1) {
    ctx.beginPath();
    ctx.moveTo(px + i * r * 0.4, py + r * 0.5);
    ctx.lineTo(px + i * r * 0.62, py - r * 0.55);
    ctx.stroke();
  }
};

/**
 * Roads are drawn, not filled.
 *
 * A road tile painted as a coloured square is the single clearest tell that a
 * map is a grid of data rather than a place. Tracing the run of road tiles and
 * stroking a ribbon over them costs nothing and is most of what separates this
 * from a spreadsheet.
 */
const drawRoads = (ctx: CanvasRenderingContext2D, map: WorldMap) => {
  const isRoad = (x: number, y: number) => terrainAt(map, x, y) === "road";
  const plaza = new Uint8Array(map.width * map.height);
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (!isRoad(x, y)) continue;
      let neighbours = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (isRoad(x + dx, y + dy)) neighbours += 1;
      }
      // A genuine square is enclosed on every side. Asking only for the four
      // orthogonal neighbours promoted the middle of any thick road run to a
      // paved slab, which is how a country lane became a car park.
      if (neighbours < 4) continue;
      let full = true;
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        if (!isRoad(x + dx, y + dy)) full = false;
      }
      if (full) plaza[y * map.width + x] = 1;
    }
  }

  const links: Array<[number, number, number, number, boolean]> = [];
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (!isRoad(x, y)) continue;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
        if (!isRoad(x + dx, y + dy)) continue;
        // A diagonal between two tiles that are already joined the long way
        // round is a duplicate, and duplicates are what build the lattice.
        if (dx && dy && isRoad(x + dx, y) && isRoad(x, y + dy)) continue;
        const open = !plaza[y * map.width + x] && !plaza[(y + dy) * map.width + (x + dx)];
        links.push([x + 0.5, y + 0.5, x + dx + 0.5, y + dy + 0.5, open]);
      }
    }
  }

  const fillPlazas = (colour: string, inset: number) => {
    ctx.fillStyle = colour;
    ctx.beginPath();
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        if (!plaza[y * map.width + x]) continue;
        ctx.rect((x - inset) * BAKE_PX, (y - inset) * BAKE_PX, (1 + inset * 2) * BAKE_PX, (1 + inset * 2) * BAKE_PX);
      }
    }
    ctx.fill();
  };

  const stroke = (colour: string, width: number, linesOnly: boolean) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    for (const [x0, y0, x1, y1, open] of links) {
      if (linesOnly && !open) continue;
      ctx.moveTo(x0 * BAKE_PX, y0 * BAKE_PX);
      ctx.lineTo(x1 * BAKE_PX, y1 * BAKE_PX);
    }
    ctx.stroke();
  };

  // A rutted dirt lane worn into the turf: a soft shadow in the hollow it sits
  // in, then dust over it. No bright centre line -- drawn down a wide run that
  // read as painted bay markings rather than as a road.
  ctx.save();
  ctx.filter = "blur(2px)";
  fillPlazas("rgba(64,49,30,0.26)", 0.10);
  stroke("rgba(64,49,30,0.26)", BAKE_PX * 0.42, false);
  ctx.restore();
  fillPlazas("rgba(186,157,116,0.72)", -0.04);
  stroke("rgba(186,157,116,0.72)", BAKE_PX * 0.26, false);
  stroke("rgba(206,180,142,0.5)", BAKE_PX * 0.1, true);
};

/** The shoreline: a pale strand and an ink edge, drawn per water tile border. */
/** Chebyshev distance from each water tile to the nearest dry tile. */
const depthField = (map: WorldMap) => {
  const out = new Float32Array(map.width * map.height);
  const queue: number[] = [];
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const i = y * map.width + x;
      if (terrainAt(map, x, y) !== "water") {
        out[i] = 0;
        queue.push(i);
      } else out[i] = Infinity;
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head] ?? 0;
    const cx = current % map.width;
    const cy = Math.floor(current / map.width);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      const next = ny * map.width + nx;
      if ((out[next] ?? 0) <= (out[current] ?? 0) + 1) continue;
      out[next] = (out[current] ?? 0) + 1;
      queue.push(next);
    }
  }
  return out;
};

/** Ripple lines struck along the length of the water, the way a chart draws it. */
const drawRipples = (ctx: CanvasRenderingContext2D, map: WorldMap) => {
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(226,240,238,0.34)";
  ctx.lineWidth = BAKE_PX * 0.045;
  ctx.beginPath();
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (terrainAt(map, x, y) !== "water") continue;
      for (let k = 0; k < 3; k += 1) {
        const seed = hash(x * 7 + k * 31, y * 11 + k * 17);
        if (seed < 0.42) continue;
        const px = (x + 0.12 + hash(x * 3 + k, y * 5) * 0.6) * BAKE_PX;
        const py = (y + 0.15 + hash(x * 5, y * 3 + k) * 0.7) * BAKE_PX;
        const len = BAKE_PX * (0.16 + seed * 0.22);
        ctx.moveTo(px, py);
        ctx.quadraticCurveTo(px + len * 0.5, py - len * 0.22, px + len, py);
      }
    }
  }
  ctx.stroke();
  ctx.restore();
};

const drawShore = (ctx: CanvasRenderingContext2D, map: WorldMap) => {
  ctx.lineWidth = BAKE_PX * 0.12;
  ctx.strokeStyle = "rgba(232,220,192,0.72)";
  ctx.beginPath();
  for (let y = 0; y < map.height; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      if (terrainAt(map, x, y) !== "water") continue;
      const edges: Array<[number, number, number, number]> = [];
      if (terrainAt(map, x, y - 1) !== "water") edges.push([x, y, x + 1, y]);
      if (terrainAt(map, x, y + 1) !== "water") edges.push([x, y + 1, x + 1, y + 1]);
      if (terrainAt(map, x - 1, y) !== "water") edges.push([x, y, x, y + 1]);
      if (terrainAt(map, x + 1, y) !== "water") edges.push([x + 1, y, x + 1, y + 1]);
      for (const [x0, y0, x1, y1] of edges) {
        ctx.moveTo(x0 * BAKE_PX, y0 * BAKE_PX);
        ctx.lineTo(x1 * BAKE_PX, y1 * BAKE_PX);
      }
    }
  }
  ctx.stroke();
};

export type BakedMap = { canvas: HTMLCanvasElement; key: string; width: number; height: number };

let cache: BakedMap | null = null;

export const bakeMap = (map: WorldMap, metresPerTile: number): BakedMap => {
  const key = `${map.id}:${map.width}x${map.height}`;
  if (cache && cache.key === key) return cache;

  const width = map.width * BAKE_PX;
  const height = map.height * BAKE_PX;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("The map board has no 2D context.");

  let lo = Infinity;
  let hi = -Infinity;
  for (const value of map.heights) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  const span = Math.max(1, hi - lo);

  const parcels = parcelField(map);
  const relief = reliefField(map, metresPerTile);
  // How far each water tile sits from dry land, so a river reads as a channel
  // rather than a flat blue ribbon.
  const depth = depthField(map);

  // Ground pass, per pixel: colour, hypsometric wash, mottle, relief.
  const image = ctx.createImageData(width, height);
  const data = image.data;
  for (let py = 0; py < height; py += 1) {
    for (let px = 0; px < width; px += 1) {
      const tx = px / BAKE_PX;
      const tz = py / BAKE_PX;
      // Jitter the lookup so a wood or a hedge ends ragged instead of square.
      const jx = tx + (valueNoise(px * 0.16, py * 0.16) - 0.5) * 0.5;
      const jz = tz + (valueNoise(px * 0.16 + 31.7, py * 0.16 - 12.3) - 0.5) * 0.5;
      const kind = terrainAt(map, Math.floor(jx), Math.floor(jz));
      const tone = PALETTE[kind] ?? PALETTE.open;
      const h = heightAtTile(map, tx, tz);
      const alt = (h - lo) / span;
      const shaded = sampleRelief(relief, tx, tz);

      // Hypsometric wash: lowland stays green, upland dries out to ochre.
      let colour: RGB = tone.base;
      if (kind === "open" || kind === "rough") {
        // A wide, slow wobble on the lookup: the parcel's painted edge then
        // wanders like a real boundary instead of stepping along tile corners.
        const wx = tx + (valueNoise(tx * 0.9 + 5.1, tz * 0.9 - 2.7) - 0.5) * 1.6;
        const wz = tz + (valueNoise(tx * 0.9 - 8.3, tz * 0.9 + 4.4) - 0.5) * 1.6;
        const parcel = parcels[Math.min(map.height - 1, Math.max(0, Math.floor(wz))) * map.width
          + Math.min(map.width - 1, Math.max(0, Math.floor(wx)))];
        const crop = CROPS[Math.floor((parcel?.crop ?? 0) * CROPS.length) % CROPS.length] ?? tone.base;
        colour = mix(tone.base, crop, kind === "open" ? 0.7 : 0.3);
        colour = mix(colour, kind === "open" ? DRY : DRY_ROUGH, Math.max(0, alt - 0.42) * 1.5);
        colour = mix(colour, LUSH, Math.max(0, 0.38 - alt) * 1.2);
      }
      if (kind === "water") {
        const far = depth[Math.min(map.height - 1, Math.max(0, Math.floor(jz))) * map.width
          + Math.min(map.width - 1, Math.max(0, Math.floor(jx)))] ?? 0;
        const deep = Math.min(1, far / 3.2);
        colour = mix(SHALLOW, PALETTE.water.low, deep * 0.85 + valueNoise(tx * 2.2, tz * 2.2) * 0.15);
      }
      const grain = valueNoise(tx * 5.5, tz * 5.5) * 0.5 + valueNoise(tx * 17, tz * 17) * 0.5;
      colour = mix(colour, grain > 0.5 ? tone.high : tone.low, Math.abs(grain - 0.5) * 0.7);

      // Relief with teeth: aspect does the lighting, slope adds its own bite,
      // so a hillside reads even when the sun is square behind the viewer.
      const lit = kind === "water"
        ? 1
        : (0.6 + shaded.lit * 0.68) * (1 - Math.min(0.3, shaded.slope * 0.4));
      const i = (py * width + px) * 4;
      // Soft shoulder: a sunlit ochre slope would otherwise clip to white and
      // leave a bald patch where the relief is strongest.
      data[i] = shoulder(colour[0] * lit);
      data[i + 1] = shoulder(colour[1] * lit);
      data[i + 2] = shoulder(colour[2] * lit);
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  drawRipples(ctx, map);
  drawShore(ctx, map);
  drawRoads(ctx, map);

  for (const sprite of scatter(map)) {
    if (sprite.kind === "woods") drawTree(ctx, sprite);
    else if (sprite.kind === "building") drawHouse(ctx, sprite);
    else drawScrub(ctx, sprite);
  }

  // An ink vignette at the board's edge, the way a printed sheet is plate-marked.
  ctx.strokeStyle = INK;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = BAKE_PX * 0.5;
  ctx.strokeRect(0, 0, width, height);
  ctx.globalAlpha = 1;

  cache = { canvas, key, width, height };
  return cache;
};
