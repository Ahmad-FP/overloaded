import type { Shape } from "./types";

/**
 * Pull a set of slots back onto its own centroid.
 *
 * Every shape here is laid out from its front rank backwards, so the mean of
 * the offsets sits behind the origin rather than on it. That is invisible
 * while a formation is marching to a cell, but a formation holding ground
 * takes its own centre as the origin -- so each frame the slots were placed
 * half a rank behind where the men already were, the men walked back to them,
 * and the whole formation crept backwards off the map. Centring the offsets
 * makes the origin mean the middle of the formation, which is what every
 * caller already assumed.
 */
const centred = (slots: Array<{ x: number; z: number }>) => {
  if (!slots.length) return slots;
  let mx = 0;
  let mz = 0;
  for (const slot of slots) {
    mx += slot.x;
    mz += slot.z;
  }
  mx /= slots.length;
  mz /= slots.length;
  for (const slot of slots) {
    slot.x -= mx;
    slot.z -= mz;
  }
  return slots;
};

const slotOffsets = (shape: Shape, count: number, spacing: number, facing: number) => {
  const s = Math.max(1.6, spacing);
  const slots: { x: number; z: number }[] = [];
  const ca = Math.cos(facing);
  const sa = Math.sin(facing);

  const place = (lx: number, lz: number) => {
    slots.push({ x: lx * ca - lz * sa, z: lx * sa + lz * ca });
  };

  if (shape === "column") {
    const width = 2;
    for (let i = 0; i < count; i += 1) {
      const row = Math.floor(i / width);
      const col = i % width;
      place((col - 0.5) * s, -row * s);
    }
    return centred(slots);
  }

  if (shape === "square") {
    const edge = Math.max(3, Math.ceil(count / 4));
    let i = 0;
    const pushEdge = (lx: number, lz: number) => {
      if (i < count) {
        place(lx, lz);
        i += 1;
      }
    };
    for (let k = 0; k < edge && i < count; k += 1) pushEdge((k - (edge - 1) / 2) * s, ((edge - 1) / 2) * s);
    for (let k = 1; k < edge && i < count; k += 1) pushEdge(((edge - 1) / 2) * s, ((edge - 1) / 2 - k) * s);
    for (let k = edge - 2; k >= 0 && i < count; k -= 1) pushEdge((k - (edge - 1) / 2) * s, -((edge - 1) / 2) * s);
    for (let k = edge - 2; k > 0 && i < count; k -= 1) pushEdge(-((edge - 1) / 2) * s, ((edge - 1) / 2 - k) * s);
    while (i < count) {
      place(0, 0);
      i += 1;
    }
    return centred(slots);
  }

  if (shape === "skirmish") {
    const cols = Math.ceil(Math.sqrt(count * 1.6));
    for (let i = 0; i < count; i += 1) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const jitter = ((i * 17) % 7) - 3;
      place((col - (cols - 1) / 2) * s * 1.45 + jitter * 0.15, -row * s * 1.3);
    }
    return centred(slots);
  }

  const front = Math.ceil(count / 2);
  for (let i = 0; i < count; i += 1) {
    const rank = i < front ? 0 : 1;
    const col = i < front ? i : i - front;
    const width = rank === 0 ? front : count - front;
    place((col - (width - 1) / 2) * s, -rank * s);
  }
  return centred(slots);
};

export const worldSlots = (
  origin: { x: number; z: number },
  shape: Shape,
  count: number,
  spacing: number,
  facing: number,
) => slotOffsets(shape, count, spacing, facing).map((slot) => ({ x: origin.x + slot.x, z: origin.z + slot.z }));

/**
 * How wide a formation stands, in metres, across its front.
 *
 * Used to decide whether it will fit through the ground ahead of it.
 */
export const frontage = (shape: Shape, count: number, spacing: number) => {
  const s = Math.max(1.6, spacing);
  if (shape === "column") return s * 2;
  if (shape === "square") return Math.max(3, Math.ceil(count / 4)) * s;
  if (shape === "skirmish") return Math.ceil(Math.sqrt(count * 1.6)) * s * 1.45;
  return Math.ceil(count / 2) * s;
};
