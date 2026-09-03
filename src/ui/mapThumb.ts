import { PREVIEW_TONE } from "./terrainArt";
import type { WorldMap } from "../domain/types";

/**
 * A postage-stamp render of a whole map, for the setup screen.
 *
 * A map should be picked by looking at it. Naming what each one is "good for"
 * tells the player what to think before they have seen the ground, and it is
 * the kind of note that belongs in a designer's file rather than on screen.
 *
 * This is drawn straight from the tile array with a light north-west shade off
 * the heightmap, so it costs a millisecond and needs none of the load-time
 * bake the real board uses.
 */
export const mapThumb = (map: WorldMap, px: number): HTMLCanvasElement => {
  const canvas = document.createElement("canvas");
  const scale = Math.max(1, Math.floor(px / Math.max(map.width, map.height)));
  canvas.width = map.width * scale;
  canvas.height = map.height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const image = ctx.createImageData(canvas.width, canvas.height);
  const at = (x: number, y: number) => {
    const cx = Math.min(map.width - 1, Math.max(0, x));
    const cy = Math.min(map.height - 1, Math.max(0, y));
    return map.heights[cy * map.width + cx] ?? 0;
  };

  for (let py = 0; py < canvas.height; py += 1) {
    for (let pxl = 0; pxl < canvas.width; pxl += 1) {
      const tx = Math.floor(pxl / scale);
      const ty = Math.floor(py / scale);
      const tone = PREVIEW_TONE[map.tiles[ty * map.width + tx] ?? "open"];
      // Sun in the north-west, the same direction the board is lit from.
      const slope = (at(tx - 1, ty - 1) - at(tx + 1, ty + 1)) * 0.09;
      const lift = Math.max(-0.32, Math.min(0.32, slope));
      const i = (py * canvas.width + pxl) * 4;
      image.data[i] = Math.max(0, Math.min(255, tone[0] * (1 + lift)));
      image.data[i + 1] = Math.max(0, Math.min(255, tone[1] * (1 + lift)));
      image.data[i + 2] = Math.max(0, Math.min(255, tone[2] * (1 + lift)));
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  // The two headquarters, so the player can read the axis of the fight.
  const dot = (x: number, y: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc((x + 0.5) * scale, (y + 0.5) * scale, Math.max(2, scale * 1.6), 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = Math.max(1, scale * 0.5);
    ctx.strokeStyle = "rgba(9,11,15,0.75)";
    ctx.stroke();
  };
  for (const depot of map.depotCells) dot(depot.x, depot.y, "#e0b95f");
  dot(map.mainCells.player.x, map.mainCells.player.y, "#4f7fc8");
  dot(map.mainCells.enemy.x, map.mainCells.enemy.y, "#c4574a");
  return canvas;
};
