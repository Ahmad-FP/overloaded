import {
  BoxGeometry, BufferGeometry, ConeGeometry, CylinderGeometry, Float32BufferAttribute,
  IcosahedronGeometry, Matrix4,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * The cast, cut in code.
 *
 * Every figure is a handful of solids welded into one flat-shaded mesh, built
 * once and drawn through an InstancedMesh — a hundred and fifty men cost three
 * draw calls, not a hundred and fifty. Each type splits into two geometries:
 * `team`, which is tinted per instance to the side's colour, and `body`, which
 * carries its own baked vertex colours. That avoids patching a shader to get
 * two colour sources into one instanced draw.
 *
 * Proportions are stylised rather than true. A man at his real 1.8 m is seven
 * pixels tall on a board where a tile is 10 m across, so the cast stands a
 * little over life size with the head, hat and shoulders pushed out until the
 * silhouette survives at a glance.
 */

export type Kit = { team: BufferGeometry; body: BufferGeometry };

const COAT_MASK = 0xffffff;

/** Give a solid flat vertex colours and drop the index so faces stay crisp. */
const paint = (geometry: BufferGeometry, colour: number) => {
  const flat = geometry.toNonIndexed();
  geometry.dispose();
  const count = flat.getAttribute("position").count;
  const values = new Float32Array(count * 3);
  const r = ((colour >> 16) & 255) / 255;
  const g = ((colour >> 8) & 255) / 255;
  const b = (colour & 255) / 255;
  for (let i = 0; i < count; i += 1) {
    values[i * 3] = r;
    values[i * 3 + 1] = g;
    values[i * 3 + 2] = b;
  }
  flat.setAttribute("color", new Float32BufferAttribute(values, 3));
  return flat;
};

const place = (
  geometry: BufferGeometry,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
) => {
  const m = new Matrix4();
  if (rx) geometry.applyMatrix4(m.makeRotationX(rx));
  if (rz) geometry.applyMatrix4(m.makeRotationZ(rz));
  if (ry) geometry.applyMatrix4(m.makeRotationY(ry));
  geometry.applyMatrix4(m.makeTranslation(x, y, z));
  return geometry;
};

const box = (w: number, h: number, d: number, colour: number) => paint(new BoxGeometry(w, h, d), colour);
const cyl = (rt: number, rb: number, h: number, seg: number, colour: number) =>
  paint(new CylinderGeometry(rt, rb, h, seg), colour);
const ball = (r: number, colour: number, detail = 0) =>
  paint(new IcosahedronGeometry(r, detail), colour);
const cone = (r: number, h: number, seg: number, colour: number) =>
  paint(new ConeGeometry(r, h, seg), colour);

const weld = (parts: BufferGeometry[]) => {
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error("A model failed to weld.");
  merged.computeVertexNormals();
  return merged;
};

// -- palette ---------------------------------------------------------------

const SKIN = 0xc99a72;
const FELT = 0x1f1c19;
const BUFF = 0xd9d2be;
const LEATHER = 0x4a3628;
const IRON = 0x3a3a3f;
const BRASS = 0xb08d3c;
const OAK = 0x8a6a3e;
const HIDE = 0x4e3b2a;
const HIDE_LIT = 0x634c36;

/**
 * A closed polygonal rampart.
 *
 * Placing wall blocks at a radius and hoping they meet gives a ring of
 * detached slabs — a flower, not a fortress. The side length of a regular
 * n-gon is fixed by its radius, so it is computed here and the blocks are
 * seated on the apothem, which makes the corners close every time.
 */
const rampart = (
  sides: number,
  radius: number,
  height: number,
  thickness: number,
  colour: number,
  capColour: number,
  spin = 0,
) => {
  const out: BufferGeometry[] = [];
  const side = 2 * radius * Math.tan(Math.PI / sides);
  const apothem = radius * Math.cos(Math.PI / sides);
  for (let i = 0; i < sides; i += 1) {
    const a = (i / sides) * Math.PI * 2 + spin;
    const cx = Math.cos(a) * apothem;
    const cz = Math.sin(a) * apothem;
    out.push(place(box(side * 1.04, height, thickness, colour), cx, height / 2, cz, 0, -a + Math.PI / 2));
    out.push(place(box(side * 1.04, height * 0.22, thickness * 1.22, capColour), cx, height * 1.06, cz, 0, -a + Math.PI / 2));
  }
  return out;
};

// -- the ranks -------------------------------------------------------------

/**
 * Line infantry: shako, coat, crossbelts, musket at the shoulder.
 * Stands 2.7 m so the hat still reads when the board is zoomed out.
 */
const infantry = (): Kit => {
  const team = weld([
    place(box(0.86, 0.92, 0.58, COAT_MASK), 0, 1.62, 0),
    // Turnbacks: the short coat tails that give the silhouette a waist.
    place(box(0.74, 0.3, 0.18, COAT_MASK), 0, 1.2, -0.2),
    place(box(0.2, 0.5, 0.2, COAT_MASK), -0.53, 1.62, 0),
    place(box(0.2, 0.5, 0.2, COAT_MASK), 0.53, 1.62, 0),
  ]);
  const body = weld([
    place(box(0.3, 1.2, 0.3, BUFF), -0.2, 0.6, 0),
    place(box(0.3, 1.2, 0.3, BUFF), 0.2, 0.6, 0),
    place(box(0.36, 0.2, 0.46, FELT), -0.2, 0.1, 0.06),
    place(box(0.36, 0.2, 0.46, FELT), 0.2, 0.1, 0.06),
    // Crossbelts. Two white straps on a dark coat is what a line of infantry
    // actually reads as at three hundred metres, so they are not a detail.
    place(box(0.22, 1.0, 0.64, BUFF), 0.0, 1.62, 0.0, 0, 0, 0.5),
    place(box(0.22, 1.0, 0.64, BUFF), 0.0, 1.62, 0.0, 0, 0, -0.5),
    place(box(0.92, 0.14, 0.6, BUFF), 0, 1.14, 0),
    place(box(0.56, 0.5, 0.34, LEATHER), 0, 1.66, -0.4),
    place(box(0.46, 0.14, 0.14, BRASS), 0, 1.6, 0.31),
    // A clear neck, so the head is a head and not the top of the coat.
    place(cyl(0.13, 0.15, 0.2, 6, SKIN), 0, 2.16, 0),
    place(ball(0.24, SKIN), 0, 2.4, 0.02),
    place(cyl(0.3, 0.27, 0.56, 8, FELT), 0, 2.82, 0),
    place(cyl(0.33, 0.33, 0.06, 8, 0x141210), 0, 3.1, 0),
    place(cyl(0.34, 0.34, 0.06, 8, 0x141210), 0, 2.56, 0.05),
    place(box(0.2, 0.16, 0.04, BRASS), 0, 2.78, 0.28),
    place(cyl(0.08, 0.03, 0.44, 5, 0xe4dfd0), 0, 3.3, -0.04),
    // Shouldered musket, in three pieces along one axis.
    //
    // It was a single dark batten the colour of the coat, 7cm thick, with the
    // bayonet mounted on the wrong side of it -- place() turns Rx then Rz, so
    // the barrel actually leans -X/+Z as it rises and the old bayonet at
    // +X/-Z floated clear of the muzzle. Rebuilt on the true axis, in pale
    // stock and bright steel: the tips stand above the shakos, which is what
    // makes a line of infantry read as a line and not a row of blocks.
    place(box(0.11, 1.0, 0.11, OAK), 0.52, 1.545, 0.12, -0.12, 0, 0.08),
    place(box(0.085, 1.05, 0.085, 0x55585f), 0.439, 2.559, -0.003, -0.12, 0, 0.08),
    place(box(0.05, 0.5, 0.05, 0xd6dae0), 0.378, 3.326, -0.095, -0.12, 0, 0.08),
  ]);
  return { team, body };
};

/** Light cavalry: a stocky horse at speed with a trooper up. */
const cavalry = (): Kit => {
  const team = weld([
    place(box(0.94, 0.92, 0.62, COAT_MASK), 0, 3.0, -0.08),
    place(box(1.4, 0.16, 1.06, COAT_MASK), 0, 2.5, -0.1),
    place(box(0.2, 0.86, 0.2, COAT_MASK), -0.44, 2.78, 0.3, 0.68),
    place(box(0.2, 0.86, 0.2, COAT_MASK), 0.44, 2.78, 0.3, 0.68),
  ]);
  const body = weld([
    place(box(1.06, 1.14, 2.5, HIDE), 0, 1.86, 0),
    place(box(0.9, 0.86, 0.9, HIDE_LIT), 0, 2.06, 0.98, -0.32),
    // Neck slimmer than the chest and a longer muzzle, so the front of the
    // horse is a head and not the corner of a crate.
    place(box(0.46, 0.46, 0.98, HIDE_LIT), 0, 2.44, 1.5, -0.5),
    place(box(0.34, 0.3, 0.66, 0x2e2119), 0, 2.3, 2.06, -0.42),
    // Mane down the crest of the neck.
    place(box(0.16, 0.2, 0.9, 0x2a1f16), 0, 2.72, 1.44, -0.5),
    place(box(0.26, 0.34, 0.14, HIDE), -0.2, 2.72, 1.66),
    place(box(0.26, 0.34, 0.14, HIDE), 0.2, 2.72, 1.66),
    place(box(0.3, 1.44, 0.32, HIDE), -0.36, 0.72, 0.88, 0.22),
    place(box(0.3, 1.44, 0.32, HIDE), 0.36, 0.72, 0.88, 0.22),
    place(box(0.3, 1.44, 0.32, HIDE), -0.36, 0.72, -0.86, -0.3),
    place(box(0.3, 1.44, 0.32, HIDE), 0.36, 0.72, -0.86, -0.3),
    place(box(0.34, 0.2, 0.34, FELT), -0.36, 0.06, 0.98),
    place(box(0.34, 0.2, 0.34, FELT), 0.36, 0.06, 0.98),
    place(box(0.34, 0.2, 0.34, FELT), -0.36, 0.06, -1.0),
    place(box(0.34, 0.2, 0.34, FELT), 0.36, 0.06, -1.0),
    place(cone(0.24, 1.0, 5, 0x2e2119), 0, 2.16, -1.34, 0.9),
    place(ball(0.13, SKIN), -0.5, 2.42, 0.72),
    place(ball(0.13, SKIN), 0.5, 2.42, 0.72),
    place(ball(0.28, SKIN), 0, 3.62, -0.06),
    place(cyl(0.34, 0.32, 0.56, 8, FELT), 0, 4.0, -0.08),
    place(cyl(0.1, 0.03, 0.5, 5, 0xd8d3c4), 0, 4.42, -0.16),
    place(box(0.06, 1.5, 0.12, 0xc3c6cc), 0.6, 3.66, 0.1, 0.24, 0, 0.34),
  ]);
  return { team, body };
};

/** A six-pounder on its carriage, with the side's colours on the ammunition chest. */
const artillery = (): Kit => {
  const team = weld([
    place(box(0.92, 0.62, 1.34, COAT_MASK), 0, 0.94, -1.5),
  ]);
  const wheel = (side: number) => [
    place(cyl(1.0, 1.0, 0.16, 12, OAK), side * 0.94, 1.0, 0.1, 0, 0, Math.PI / 2),
    place(cyl(1.04, 1.04, 0.1, 12, LEATHER), side * 1.0, 1.0, 0.1, 0, 0, Math.PI / 2),
    place(cyl(0.2, 0.2, 0.4, 8, IRON), side * 0.94, 1.0, 0.1, 0, 0, Math.PI / 2),
    place(box(0.1, 1.86, 0.1, OAK), side * 0.9, 1.0, 0.1, 0, 0, 0.5),
    place(box(0.1, 1.86, 0.1, OAK), side * 0.9, 1.0, 0.1, 0, 0, -0.5),
  ];
  const body = weld([
    ...wheel(-1),
    ...wheel(1),
    place(box(0.66, 0.4, 2.9, OAK), 0, 0.86, -0.9, -0.12),
    place(box(0.44, 0.36, 0.9, OAK), 0, 1.34, 0.42, -0.12),
    place(cyl(0.2, 0.26, 2.5, 10, IRON), 0, 1.62, 0.86, Math.PI / 2 - 0.14),
    place(cyl(0.3, 0.3, 0.24, 10, BRASS), 0, 1.56, -0.32, Math.PI / 2 - 0.14),
    place(cyl(0.22, 0.22, 0.16, 10, BRASS), 0, 1.78, 1.98, Math.PI / 2 - 0.14),
    place(box(0.26, 0.26, 0.9, IRON), 0, 0.5, -2.16, -0.12),
  ]);
  return { team, body };
};

// -- the country -----------------------------------------------------------

/** Two canopies over a trunk. Stylised, chunky, and cheap enough to instance. */
const tree = (): Kit => {
  const body = weld([
    place(cyl(0.42, 0.62, 3.4, 6, 0x4a3a28), 0, 1.7, 0),
    place(ball(2.5, 0x3f6134, 1), 0, 4.6, 0),
    place(ball(1.8, 0x517a3e, 1), -0.9, 5.9, 0.5),
    place(ball(1.5, 0x33512b, 1), 1.2, 5.1, -0.7),
  ]);
  return { team: new BufferGeometry(), body };
};

/** A cottage: plastered walls, a pitched roof, a chimney. */
const house = (): Kit => {
  const body = weld([
    place(box(5.4, 3.4, 4.2, 0xe4dbc6), 0, 1.7, 0),
    place(box(0.3, 3.4, 4.3, 0x8c7a5e), -2.6, 1.7, 0),
    place(box(0.3, 3.4, 4.3, 0x8c7a5e), 2.6, 1.7, 0),
    // A gable, not a pyramid: two pitched slabs meeting at a ridge.
    place(box(5.9, 0.42, 3.1, 0xa8402f), 0, 4.34, -1.16, 0.62),
    place(box(5.9, 0.42, 3.1, 0xa8402f), 0, 4.34, 1.16, -0.62),
    place(box(5.9, 0.3, 0.4, 0x8c3324), 0, 5.28, 0),
    place(box(0.7, 1.9, 0.7, 0xb5a58c), 1.7, 5.2, 0),
    place(box(0.9, 1.6, 0.14, 0x5f4a32), -0.6, 0.8, 2.14),
  ]);
  return { team: new BufferGeometry(), body };
};

// -- works -----------------------------------------------------------------

/** A bastioned headquarters: a raised platform, a closed rampart, a keep. */
const fort = (): Kit => {
  const team = weld([
    place(box(4.6, 2.8, 0.16, COAT_MASK), 2.3, 17.2, 0),
  ]);
  const bastions: BufferGeometry[] = [];
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const cx = Math.cos(a) * 9.6;
    const cz = Math.sin(a) * 9.6;
    bastions.push(place(cyl(3.4, 4.6, 5.2, 5, 0x7d6d4e), cx, 2.6, cz, 0, -a));
    bastions.push(place(cyl(3.9, 3.9, 0.7, 5, 0x5f5238), cx, 5.4, cz, 0, -a));
  }
  const body = weld([
    place(cyl(11.6, 12.6, 1.4, 8, 0x8b7c5b), 0, 0.7, 0),
    ...rampart(8, 10.6, 4.6, 2.4, 0x8f8062, 0x655843, Math.PI / 8),
    ...bastions,
    place(box(9.0, 6.2, 8.0, 0xdbd1b7), 0, 4.4, 0),
    place(box(9.4, 0.5, 8.4, 0xa89578), 0, 7.6, 0),
    place(cyl(0.02, 7.4, 4.2, 4, 0x7c3b2b), 0, 9.6, 0, 0, Math.PI / 4),
    place(box(1.4, 2.6, 0.4, 0x5f4a32), 0, 2.8, 4.1),
    place(cyl(0.24, 0.24, 13.0, 6, 0x7a6a52), 2.3, 12.0, 0),
  ]);
  return { team, body };
};

/** A field redoubt: a five-sided earth parapet with a palisade and a standard. */
const redoubt = (): Kit => {
  const team = weld([
    place(box(2.8, 1.7, 0.12, COAT_MASK), 1.4, 10.4, 0),
  ]);
  const body = weld([
    place(cyl(5.6, 6.4, 0.9, 5, 0x8b7c5b), 0, 0.45, 0),
    ...rampart(5, 5.6, 3.0, 1.8, 0x93835f, 0x6b5c40, 0.3),
    place(box(4.0, 2.8, 4.0, 0xcabd9f), 0, 2.3, 0),
    place(box(4.4, 0.4, 4.4, 0x8e7f5f), 0, 3.9, 0),
    place(cyl(0.18, 0.18, 8.4, 6, 0x7a6a52), 1.4, 7.2, 0),
  ]);
  return { team, body };
};

/** A depot: crates under a tarpaulin, with a claim post. */
const depot = (): Kit => {
  const team = weld([
    place(box(2.0, 1.2, 0.1, COAT_MASK), 1.1, 7.6, 0),
  ]);
  const body = weld([
    place(box(3.6, 2.6, 3.6, 0xa07e4e), -1.5, 1.3, -0.9),
    place(box(3.0, 2.2, 3.0, 0xb08a56), 1.7, 1.1, 1.0),
    place(box(2.6, 2.0, 2.6, 0x8f6f45), 0.1, 3.5, -0.6),
    place(box(3.8, 0.24, 0.5, 0x6a5233), -1.5, 1.95, 0.95),
    place(box(0.5, 0.24, 3.8, 0x6a5233), 0.7, 1.75, 1.0, 0, Math.PI / 2),
    place(box(2.8, 0.22, 2.8, 0x6a5233), 0.1, 4.62, -0.6),
    place(cyl(0.16, 0.16, 6.0, 5, 0x7a6a52), 1.1, 3.0, 0),
  ]);
  return { team, body };
};

let built: Record<string, Kit> | null = null;

export const kits = () => {
  if (built) return built;
  built = {
    infantry: infantry(),
    cavalry: cavalry(),
    artillery: artillery(),
    tree: tree(),
    house: house(),
    main: fort(),
    fob: redoubt(),
    depot: depot(),
  };
  return built;
};
