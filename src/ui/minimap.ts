import { TILE_M } from "../domain/constants";
import type { Match } from "../domain/match";
import type { Board } from "../render/board";
import { PREVIEW_TONE } from "./terrainArt";
import type { Cell, WorldMap } from "../domain/types";
import { panel } from "./panel";

/**
 * The minimap.
 *
 * Without one the player never sees the shape of the field at once, which is
 * most of why a fifty-six-tile map read as a small rectangle.
 *
 * The lenses exist because the two questions actually asked of this game --
 * where is the front, and what is cut off -- cannot be answered from terrain,
 * and a lens that answers a question beats ten that decorate.
 *
 * Terrain is baked once per map. Everything that moves is painted over it each
 * frame: a few hundred rectangles on a canvas 260px wide.
 */

const DOT = {
  player: "#5b8ede",
  enemy: "#d05c49",
  neutral: "#d8b449",
} as const;

export type Lens = "ground" | "control" | "supply";

const LENSES: ReadonlyArray<readonly [Lens, string, string]> = [
  ["ground", "Ground", "The lie of the land: woods, rough going, roads and height."],
  ["control", "Control", "Whose ground is whose. The front is where the two washes meet."],
  ["supply", "Supply", "Which works still trace a route home, and which are cut off."],
];

export class Minimap {
  readonly root: HTMLElement;
  private canvas = document.createElement("canvas");
  private ctx: CanvasRenderingContext2D | null;
  private terrain: HTMLCanvasElement | null = null;
  private bakedFor = "";
  private dragging = false;
  private lens: Lens = "ground";
  private tabs = new Map<Lens, HTMLButtonElement>();
  /** The fog-and-lens layer, rebuilt only when what the player knows changes. */
  private layer: HTMLCanvasElement | null = null;
  private layerFor: object | null = null;
  private layerLens: Lens | null = null;

  constructor(private readonly board: Board, private readonly onJump: (cell: Cell) => void) {
    const shell = panel("Field", "minimap", "left");
    this.root = shell.root;

    const lenses = document.createElement("div");
    lenses.className = "lenses";
    for (const [key, label, why] of LENSES) {
      const tab = document.createElement("button");
      tab.className = "lens";
      tab.textContent = label;
      tab.title = why;
      tab.dataset.on = key === this.lens ? "1" : "0";
      tab.addEventListener("click", () => this.setLens(key));
      this.tabs.set(key, tab);
      lenses.append(tab);
    }

    this.canvas.className = "minimap-canvas";
    this.canvas.width = 260;
    this.canvas.height = 178;
    shell.body.append(lenses, this.canvas);
    this.ctx = this.canvas.getContext("2d");

    const jump = (event: PointerEvent) => {
      const map = this.map;
      if (!map) return;
      const box = this.canvas.getBoundingClientRect();
      const fx = (event.clientX - box.left) / box.width;
      const fy = (event.clientY - box.top) / box.height;
      this.onJump({
        x: Math.max(0, Math.min(map.width - 1, Math.round(fx * map.width))),
        y: Math.max(0, Math.min(map.height - 1, Math.round(fy * map.height))),
      });
    };
    this.canvas.addEventListener("pointerdown", (event) => {
      this.dragging = true;
      this.canvas.setPointerCapture(event.pointerId);
      jump(event);
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (this.dragging) jump(event);
    });
    this.canvas.addEventListener("pointerup", () => { this.dragging = false; });
    this.canvas.addEventListener("pointercancel", () => { this.dragging = false; });
  }

  setLens(lens: Lens) {
    this.lens = lens;
    this.layerFor = null;
    for (const [key, tab] of this.tabs) tab.dataset.on = key === lens ? "1" : "0";
  }

  /** Step to the next lens, for the keyboard. */
  cycleLens() {
    const order = LENSES.map(([key]) => key);
    const at = order.indexOf(this.lens);
    this.setLens(order[(at + 1) % order.length] ?? "ground");
    return this.lens;
  }

  private map: WorldMap | null = null;

  /** Bake the ground once; it never changes inside a match. */
  private bake(map: WorldMap) {
    if (this.bakedFor === map.id && this.terrain) return;
    const tile = document.createElement("canvas");
    tile.width = map.width;
    tile.height = map.height;
    const paint = tile.getContext("2d");
    if (!paint) return;
    const image = paint.createImageData(map.width, map.height);
    for (let y = 0; y < map.height; y += 1) {
      for (let x = 0; x < map.width; x += 1) {
        const i = y * map.width + x;
        const tone = PREVIEW_TONE[map.tiles[i] ?? "open"];
        // A little north-west shading, so ridges read as ridges.
        const here = map.heights[i] ?? 0;
        const up = map.heights[Math.max(0, i - map.width - 1)] ?? here;
        const lift = Math.max(-26, Math.min(26, (up - here) * -9));
        image.data[i * 4] = Math.max(0, Math.min(255, tone[0] + lift));
        image.data[i * 4 + 1] = Math.max(0, Math.min(255, tone[1] + lift));
        image.data[i * 4 + 2] = Math.max(0, Math.min(255, tone[2] + lift));
        image.data[i * 4 + 3] = 255;
      }
    }
    paint.putImageData(image, 0, 0);
    this.terrain = tile;
    this.bakedFor = map.id;
  }

  /**
   * The fog and the lens wash, as one bitmap at one pixel per tile.
   *
   * These used to be painted per tile per frame. That is a few thousand
   * rectangles on the small fields and a quarter of a million on the large
   * ones -- at sixty frames a second, enough to halve the frame rate on its
   * own. Both only change when the player's knowledge does, which is twice a
   * second at most, so they are composed once per change into a bitmap the
   * size of the map and then scaled up in one blit.
   */
  private compose(map: WorldMap, known: { explored: Uint8Array; owner: Int8Array }) {
    if (this.layerFor === known && this.layerLens === this.lens && this.layer) return this.layer;
    const tile = this.layer && this.layer.width === map.width && this.layer.height === map.height
      ? this.layer
      : document.createElement("canvas");
    tile.width = map.width;
    tile.height = map.height;
    const paint = tile.getContext("2d");
    if (!paint) return null;
    const image = paint.createImageData(map.width, map.height);
    const data = image.data;
    const control = this.lens === "control";
    for (let i = 0; i < map.width * map.height; i += 1) {
      const at = i * 4;
      if (!known.explored[i]) {
        data[at] = 15;
        data[at + 1] = 16;
        data[at + 2] = 19;
        data[at + 3] = 158;
        continue;
      }
      if (!control) continue;
      const claim = known.owner[i] ?? 0;
      if (!claim) continue;
      const weight = Math.min(0.6, Math.abs(claim) / 150);
      data[at] = claim > 0 ? 91 : 208;
      data[at + 1] = claim > 0 ? 142 : 92;
      data[at + 2] = claim > 0 ? 222 : 73;
      data[at + 3] = Math.round(weight * 255);
    }
    paint.putImageData(image, 0, 0);
    this.layer = tile;
    this.layerFor = known;
    this.layerLens = this.lens;
    return tile;
  }

  draw(match: Match, known: { explored: Uint8Array; owner: Int8Array } | null) {
    const ctx = this.ctx;
    if (!ctx) return;
    const map = match.world;
    this.map = map;
    this.bake(map);
    const { width: w, height: h } = this.canvas;
    const sx = w / map.width;
    const sy = h / map.height;
    const explored = known?.explored ?? null;

    ctx.clearRect(0, 0, w, h);
    if (this.terrain) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.terrain, 0, 0, w, h);
    }
    // Under a lens the ground is only a backdrop, so it goes down flat.
    if (this.lens !== "ground") {
      ctx.fillStyle = "rgba(16,17,21,0.5)";
      ctx.fillRect(0, 0, w, h);
    }
    const layer = known ? this.compose(map, known) : null;
    if (layer) ctx.drawImage(layer, 0, 0, w, h);

    if (this.lens !== "supply") {
      for (const unit of match.units.values()) {
        if (!unit.alive) continue;
        if (unit.side !== "player" && !match.visibleTo("player", unit).seen) continue;
        ctx.fillStyle = DOT[unit.side];
        ctx.fillRect((unit.x / TILE_M) * sx - 0.5, (unit.z / TILE_M) * sy - 0.5,
          Math.max(1.6, sx), Math.max(1.6, sy));
      }
    }

    if (this.lens === "supply") {
      // The route each work walks home, which is the thing you cut.
      ctx.lineWidth = 1.2;
      for (const structure of match.structuresOf("player")) {
        if (structure.route.length < 2) continue;
        ctx.strokeStyle = structure.connected ? "rgba(140,196,140,0.75)" : "rgba(214,96,80,0.75)";
        ctx.beginPath();
        structure.route.forEach((step, at) => {
          const px = (step.x + 0.5) * sx;
          const py = (step.y + 0.5) * sy;
          if (at === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      }
    }

    for (const structure of match.structures.values()) {
      const i = structure.cell.y * map.width + structure.cell.x;
      if (explored && !explored[i]) continue;
      const size = structure.kind === "main" ? 7 : 5;
      const x = structure.cell.x * sx - size / 2;
      const y = structure.cell.y * sy - size / 2;
      ctx.fillStyle = this.lens === "supply" && structure.side === "player"
        ? (structure.connected ? "#8cc48c" : "#d66050")
        : DOT[structure.side];
      ctx.fillRect(x, y, size, size);
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, size, size);
    }

    // The camera's own footprint, so the player always knows where they are.
    const view = this.board.viewport();
    ctx.strokeStyle = "rgba(244,230,189,0.9)";
    ctx.lineWidth = 1.4;
    ctx.strokeRect(
      (view.x - view.w / 2) * sx,
      (view.y - view.h / 2) * sy,
      view.w * sx,
      view.h * sy,
    );
  }
}
