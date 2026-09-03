import { MAIN_SIGHT_TILES, SIGHT_TILES, TILE_M, type WorkKind } from "../domain/constants";
import type { Match } from "../domain/match";
import { heightAt } from "../domain/terrain";
import type { Binding, Cell, Owner, Structure, Unit, UnitType } from "../domain/types";
import type { Board } from "../render/board";

/**
 * Everything drawn flat.
 *
 * Two surfaces, because two things want different coordinates. The *veil* is
 * painted in tile space and wrapped onto the ground mesh, so territory, supply
 * lines and fog bend over every ridge exactly as the terrain does. The
 * *screen* layer is painted in pixels on top of the render, so a formation's
 * banner is always the same size and always legible, however far away the
 * formation is standing.
 */

const PLAYER = { ink: "#2f5fa8", wash: "rgba(63,116,196,0.075)", light: "#8ab0ee" };
const ENEMY = { ink: "#a8392c", wash: "rgba(184,64,48,0.075)", light: "#e79082" };
const NEUTRAL = { ink: "#8a7a52", wash: "rgba(150,132,86,0.05)", light: "#d3c08a" };
/**
 * Ground nobody has walked yet.
 *
 * Cool slate, a shade off the instrument plates, with a soft feathered edge.
 * Two earlier passes were wrong in opposite directions: near-black read as a
 * hole in the screen, and warm parchment read as dirt and fought the panels.
 * Unsurveyed ground should recede quietly and let the board be the bright
 * thing.
 */
// Unexplored ground is washed, not blanked. An opaque veil over everything
// the army has not walked past makes a 56-tile field look like a small
// rectangle floating in the dark, so the land shows faintly through and the
// player can see the shape of the country they have yet to scout.
const UNSEEN = "rgba(15,16,19,0.58)";
const SHADE = "rgba(15,16,19,0.24)";
/** How far the fog frontier is feathered, in veil pixels. */
const FEATHER = 5;

const tone = (side: Owner) => (side === "player" ? PLAYER : side === "enemy" ? ENEMY : NEUTRAL);

type Vision = { seen: Uint8Array; explored: Uint8Array; owner: Int8Array };
export type Marquee = { x0: number; y0: number; x1: number; y1: number };

const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

export class Overlay {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  hover: Cell | null = null;
  marquee: Marquee | null = null;
  selection = new Set<string>();
  /** The base the player has clicked, whose detail the tray is showing. */
  work: string | null = null;
  /** Set while the player is siting a redoubt. */
  /** The work the player is siting, or null when not building. */
  placing: WorkKind | null = null;
  /** True while the player is marking the ground a standing order aims at. */
  marking = false;
  /**
   * Held-key order overlay.
   *
   * Total War hangs every unit's destination and path off one held key rather
   * than spending permanent screen on it, which is the right trade: the
   * information is wanted for two seconds at a time, in bulk, and never while
   * you are reading anything else.
   */
  showPaths = false;

  private vision: Vision | null = null;
  private visionKey = "";
  private visionAge = 99;
  private visionTurn = 0;
  private veilAge = 99;
  private muzzle: Array<{ x: number; z: number; at: number }> = [];
  private banners: Array<{ name: string; x: number; y: number; w: number; h: number }> = [];

  constructor(host: HTMLElement, private board: Board) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "overlay";
    host.append(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("The overlay has no 2D context.");
    this.ctx = ctx;
    this.resize();
  }

  resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
  }

  get viewW() {
    return this.canvas.width / this.dpr;
  }

  get viewH() {
    return this.canvas.height / this.dpr;
  }

  flash(x: number, z: number, now: number) {
    this.muzzle.push({ x, z, at: now });
    if (this.muzzle.length > 240) this.muzzle.splice(0, this.muzzle.length - 240);
  }

  // -- what the player knows ------------------------------------------------

  /**
   * Sight and ownership, as stamped radii.
   *
   * An exact answer costs more than it is worth at two thousand tiles and
   * sixty frames a second, and the stamped one is what the player reads
   * anyway. Refreshed twice a second and whenever the works change, so the
   * borders never crawl.
   */
  private refreshVision(match: Match, dt: number) {
    const map = match.world;
    const key = [...match.structures.values()].map((s) => `${s.id}${s.side}`).join("|");
    this.visionAge += dt;
    if (this.vision && key === this.visionKey && this.visionAge < 0.4) return false;
    this.visionAge = 0;
    this.visionKey = key;
    const size = map.width * map.height;
    const previous = this.vision;
    const vision: Vision = {
      seen: new Uint8Array(size),
      explored: previous && previous.explored.length === size ? previous.explored : new Uint8Array(size),
      owner: new Int8Array(size),
    };
    const stamp = (target: Uint8Array, cx: number, cy: number, radius: number) => {
      const r = Math.ceil(radius);
      for (let y = cy - r; y <= cy + r; y += 1) {
        for (let x = cx - r; x <= cx + r; x += 1) {
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
          if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
          target[y * map.width + x] = 1;
        }
      }
    };
    for (const unit of match.living("player")) {
      stamp(vision.seen, Math.floor(unit.x / TILE_M), Math.floor(unit.z / TILE_M), SIGHT_TILES);
    }
    for (const structure of match.structuresOf("player")) {
      stamp(vision.seen, structure.cell.x, structure.cell.y, structure.kind === "main" ? MAIN_SIGHT_TILES : SIGHT_TILES);
    }
    for (let i = 0; i < size; i += 1) if (vision.seen[i]) vision.explored[i] = 1;

    const claims = [...match.structures.values()].filter((s) => s.side !== "neutral");
    for (const claim of claims) {
      const reach = claim.kind === "main" ? 13 : claim.kind === "fort" ? 9 : claim.kind === "depot" ? 6 : 7;
      const mark = claim.side === "player" ? 1 : -1;
      const r = Math.ceil(reach);
      for (let y = claim.cell.y - r; y <= claim.cell.y + r; y += 1) {
        for (let x = claim.cell.x - r; x <= claim.cell.x + r; x += 1) {
          if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
          const d2 = (x - claim.cell.x) ** 2 + (y - claim.cell.y) ** 2;
          if (d2 > reach * reach) continue;
          const i = y * map.width + x;
          const strength = Math.round((reach - Math.sqrt(d2)) * 4);
          const held = vision.owner[i] ?? 0;
          if (Math.abs(held) < strength) vision.owner[i] = mark * Math.min(120, strength);
        }
      }
    }
    this.vision = vision;
    this.visionTurn += 1;
    return true;
  }

  /** What the player has uncovered, for the minimap to shade. */
  known(): { explored: Uint8Array; owner: Int8Array } | null {
    return this.vision;
  }

  canSee(match: Match, unit: Unit) {
    const vision = this.vision;
    if (!vision) return false;
    const x = Math.floor(unit.x / TILE_M);
    const y = Math.floor(unit.z / TILE_M);
    if (x < 0 || y < 0 || x >= match.world.width || y >= match.world.height) return false;
    return vision.seen[y * match.world.width + x] === 1;
  }

  // -- the veil -------------------------------------------------------------

  /** Territory, supply lines and fog, painted into the texture on the ground. */
  private paintVeil(match: Match, now: number, forced: boolean) {
    this.veilAge += 1 / 60;
    if (!forced && this.veilAge < 0.12) return;
    this.veilAge = 0;
    const vision = this.vision;
    if (!vision) return;
    const map = match.world;
    const { canvas, pixelsPerTile } = this.board.veilCanvas();
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(pixelsPerTile, 0, 0, pixelsPerTile, 0, 0);
    ctx.lineJoin = "round";

    const owned = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) return 0;
      const v = vision.owner[y * map.width + x] ?? 0;
      return v > 0 ? 1 : v < 0 ? -1 : 0;
    };
    ctx.save();
    ctx.filter = "blur(2.6px)";
    for (const side of [1, -1] as const) {
      const paint = side === 1 ? PLAYER : ENEMY;
      ctx.fillStyle = paint.wash;
      ctx.beginPath();
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          if (owned(x, y) === side) ctx.rect(x, y, 1, 1);
        }
      }
      ctx.fill();
      ctx.strokeStyle = paint.ink;
      ctx.lineWidth = 0.16;
      ctx.lineCap = "round";
      ctx.beginPath();
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          if (owned(x, y) !== side) continue;
          if (owned(x, y - 1) !== side) { ctx.moveTo(x, y); ctx.lineTo(x + 1, y); }
          if (owned(x, y + 1) !== side) { ctx.moveTo(x, y + 1); ctx.lineTo(x + 1, y + 1); }
          if (owned(x - 1, y) !== side) { ctx.moveTo(x, y); ctx.lineTo(x, y + 1); }
          if (owned(x + 1, y) !== side) { ctx.moveTo(x + 1, y); ctx.lineTo(x + 1, y + 1); }
        }
      }
      ctx.stroke();
    }
    ctx.restore();

    for (const structure of match.structures.values()) {
      if (structure.side !== "player" || !structure.route.length) continue;
      ctx.strokeStyle = "rgba(18,14,9,0.42)";
      ctx.lineWidth = 0.26;
      ctx.lineCap = "round";
      ctx.beginPath();
      structure.route.forEach((cell, i) => {
        const px = cell.x + 0.5;
        const py = cell.y + 0.5;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.strokeStyle = structure.connected ? PLAYER.light : ENEMY.light;
      ctx.lineWidth = 0.14;
      ctx.setLineDash([0.4, 0.34]);
      ctx.lineDashOffset = structure.connected ? -now * 1.6 : 0;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Both fogs go down as one path each under a blur, so the frontier is a
    // soft edge instead of a row of squares. Overshooting each tile by a
    // little closes the seams the blur would otherwise open between them.
    const bleed = 0.06;
    const fog = (fill: string, wanted: (i: number) => boolean) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      for (let y = 0; y < map.height; y += 1) {
        for (let x = 0; x < map.width; x += 1) {
          if (!wanted(y * map.width + x)) continue;
          ctx.rect(x - bleed, y - bleed, 1 + bleed * 2, 1 + bleed * 2);
        }
      }
      ctx.fill();
    };
    ctx.save();
    ctx.filter = `blur(${FEATHER}px)`;
    fog(SHADE, (i) => !vision.seen[i] && Boolean(vision.explored[i]));
    fog(UNSEEN, (i) => !vision.explored[i]);
    ctx.restore();
    this.board.veilPainted();
  }

  // -- the frame ------------------------------------------------------------

  /**
   * Work out what the player knows, before anything is placed or drawn.
   *
   * Runs ahead of the render so the board can gate the scenery and the enemy
   * on the same answer the veil is painted from — one source of truth for
   * what is on the chart this frame.
   */
  think(match: Match, now: number, dt: number) {
    const forced = this.refreshVision(match, dt);
    if (this.vision) this.board.setVision(this.vision, this.visionTurn);
    this.paintVeil(match, now, forced);
  }

  draw(match: Match, now: number) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.viewW, this.viewH);
    this.drawSelection(ctx, match);
    this.drawOrders(ctx, match);
    this.drawShots(ctx, match, now);
    this.drawCursor(ctx, match);
    this.drawBanners(ctx, match);
    this.drawMarquee(ctx);
  }

  private centreOf(match: Match, binding: Binding) {
    const members = match.bindingUnits(binding);
    if (!members.length) return null;
    let x = 0;
    let z = 0;
    for (const unit of members) {
      x += unit.x;
      z += unit.z;
    }
    return { x: x / members.length, z: z / members.length, strength: members.length };
  }

  private drawSelection(ctx: CanvasRenderingContext2D, match: Match) {
    if (!this.selection.size) return;
    ctx.strokeStyle = "rgba(216,180,92,0.9)";
    ctx.lineWidth = 1.6;
    for (const name of this.selection) {
      const binding = match.bindingByName(name);
      if (!binding) continue;
      for (const unit of match.bindingUnits(binding)) {
        const at = this.board.screenOf(unit);
        if (at.behind) continue;
        const r = Math.max(3, 9 * this.board.zoom);
        ctx.beginPath();
        ctx.ellipse(at.x, at.y + r * 0.5, r, r * 0.42, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private drawOrders(ctx: CanvasRenderingContext2D, match: Match) {
    const shown = this.showPaths
      ? [...match.bindings.values()].filter((binding) => binding.side === "player")
      : [...this.selection].map((name) => match.bindingByName(name));
    for (const binding of shown) {
      if (!binding) continue;
      const centre = this.centreOf(match, binding);
      const goal = binding.order.cells[0];
      if (!centre || !goal) continue;
      const from = this.board.project(centre.x, heightAt(match.world, centre.x, centre.z) + 3, centre.z);
      const gx = (goal.x + 0.5) * TILE_M;
      const gz = (goal.y + 0.5) * TILE_M;
      const to = this.board.project(gx, heightAt(match.world, gx, gz) + 3, gz);
      if (from.behind || to.behind) continue;
      const hostile = binding.order.kind === "attack_area" || binding.order.kind === "charge"
        || binding.order.kind === "bombard";
      ctx.strokeStyle = hostile ? "rgba(224,120,100,0.85)" : "rgba(216,180,92,0.8)";
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 6]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.setLineDash([]);
      const a = Math.atan2(to.y - from.y, to.x - from.x);
      ctx.fillStyle = hostile ? "rgba(224,120,100,0.95)" : "rgba(216,180,92,0.95)";
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - Math.cos(a - 0.4) * 11, to.y - Math.sin(a - 0.4) * 11);
      ctx.lineTo(to.x - Math.cos(a + 0.4) * 11, to.y - Math.sin(a + 0.4) * 11);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawShots(ctx: CanvasRenderingContext2D, match: Match, now: number) {
    ctx.strokeStyle = "rgba(255,226,168,0.75)";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (const shot of match.projectiles) {
      const head = this.board.project(shot.x, shot.y + 1.2, shot.z);
      if (head.behind) continue;
      const tail = this.board.project(shot.x - shot.vx * 0.05, shot.y + 1.2 - shot.vy * 0.05, shot.z - shot.vz * 0.05);
      ctx.moveTo(tail.x, tail.y);
      ctx.lineTo(head.x, head.y);
    }
    ctx.stroke();

    this.muzzle = this.muzzle.filter((puff) => now - puff.at < 0.35);
    for (const puff of this.muzzle) {
      const age = (now - puff.at) / 0.35;
      if (age < 0) continue;
      const at = this.board.project(puff.x, heightAt(match.world, puff.x, puff.z) + 2.4, puff.z);
      if (at.behind) continue;
      ctx.fillStyle = `rgba(255,220,150,${(0.5 * (1 - age)).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(at.x, at.y, Math.max(0.5, (3 + age * 9) * Math.max(0.5, this.board.zoom)), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** The tile under the pointer, drawn as a quad so it lies on the ground. */
  private drawCursor(ctx: CanvasRenderingContext2D, match: Match) {
    const cell = this.hover;
    if (!cell) return;
    const legal = this.placing ? match.canBuild("player", this.placing, cell).ok : true;
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
    ctx.beginPath();
    corners.forEach(([dx, dy], i) => {
      const x = (cell.x + dx) * TILE_M;
      const z = (cell.y + dy) * TILE_M;
      const at = this.board.project(x, heightAt(match.world, x, z) + 0.4, z);
      if (i === 0) ctx.moveTo(at.x, at.y); else ctx.lineTo(at.x, at.y);
    });
    ctx.closePath();
    if (this.placing || this.marking) {
      ctx.fillStyle = this.marking
        ? "rgba(216,180,92,0.2)"
        : legal ? "rgba(216,180,92,0.28)" : "rgba(196,87,74,0.3)";
      ctx.fill();
    }
    ctx.strokeStyle = this.placing
      ? (legal ? "rgba(230,200,120,0.95)" : "rgba(220,110,96,0.95)")
      : this.marking ? "rgba(230,200,120,0.95)" : "rgba(238,228,200,0.4)";
    ctx.lineWidth = this.placing || this.marking ? 2 : 1.2;
    ctx.stroke();
  }

  /** The chit that names a formation and says how many are left in it. */
  private drawBanners(ctx: CanvasRenderingContext2D, match: Match) {
    this.banners = [];
    type Chit = { at: { x: number; y: number; behind: boolean }; binding: Binding; strength: number };
    const chits: Chit[] = [];
    for (const binding of match.bindings.values()) {
      const centre = this.centreOf(match, binding);
      if (!centre) continue;
      if (binding.side !== "player") {
        const members = match.bindingUnits(binding);
        if (!members.some((unit) => this.canSee(match, unit))) continue;
      }
      const at = this.board.project(centre.x, heightAt(match.world, centre.x, centre.z) + 14, centre.z);
      if (at.behind) continue;
      chits.push({ at, binding, strength: centre.strength });
    }
    chits.sort((a, b) => a.at.y - b.at.y);

    for (const chit of chits) {
      const paint = tone(chit.binding.side);
      const mine = chit.binding.side === "player";
      const chosen = mine && this.selection.has(chit.binding.name);
      const w = 46;
      const h = 20;
      const x = chit.at.x - w / 2;
      const y = chit.at.y - h;
      ctx.globalAlpha = mine ? 1 : 0.94;
      roundRect(ctx, x, y, w, h, 3);
      ctx.fillStyle = "rgba(16,13,9,0.86)";
      ctx.fill();
      ctx.strokeStyle = chosen ? "#d8b45c" : paint.ink;
      ctx.lineWidth = chosen ? 2 : 1.3;
      ctx.stroke();
      ctx.fillStyle = paint.ink;
      roundRect(ctx, x + 1.5, y + 1.5, 15, h - 3, 2);
      ctx.fill();
      this.glyph(ctx, this.armOf(match, chit.binding), x + 9, y + h / 2);
      ctx.fillStyle = "#efe6d2";
      ctx.font = "500 12px 'Oswald Variable', Oswald, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(chit.strength), x + 31, y + h / 2 + 0.5);
      if (mine) {
        ctx.fillStyle = "rgba(212,200,172,0.9)";
        ctx.font = "400 9px 'Oswald Variable', Oswald, sans-serif";
        ctx.fillText(chit.binding.name.toUpperCase(), chit.at.x, y - 5);
      }
      ctx.globalAlpha = 1;
      this.banners.push({ name: chit.binding.name, x, y, w, h });
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  /** Map-symbol shorthand: crossed belts for foot, a bend for horse, a wheel for artillery. */
  private glyph(ctx: CanvasRenderingContext2D, type: UnitType, cx: number, cy: number) {
    ctx.strokeStyle = "rgba(240,234,216,0.95)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (type === "infantry") {
      ctx.moveTo(cx - 4.2, cy - 4.2);
      ctx.lineTo(cx + 4.2, cy + 4.2);
      ctx.moveTo(cx + 4.2, cy - 4.2);
      ctx.lineTo(cx - 4.2, cy + 4.2);
    } else if (type === "cavalry") {
      ctx.moveTo(cx - 4.4, cy + 4.2);
      ctx.lineTo(cx + 4.4, cy - 4.2);
    } else {
      ctx.arc(cx, cy, 3.6, 0, Math.PI * 2);
      ctx.moveTo(cx - 4.6, cy);
      ctx.lineTo(cx + 4.6, cy);
    }
    ctx.stroke();
  }

  /** What a formation mostly is, for its symbol. */
  private armOf(match: Match, binding: Binding): UnitType {
    const tally: Record<UnitType, number> = { infantry: 0, cavalry: 0, artillery: 0 };
    for (const unit of match.bindingUnits(binding)) tally[unit.type] += 1;
    if (tally.artillery >= tally.infantry && tally.artillery >= tally.cavalry) return "artillery";
    return tally.cavalry > tally.infantry ? "cavalry" : "infantry";
  }

  private drawMarquee(ctx: CanvasRenderingContext2D) {
    const box = this.marquee;
    if (!box) return;
    const x = Math.min(box.x0, box.x1);
    const y = Math.min(box.y0, box.y1);
    const w = Math.abs(box.x1 - box.x0);
    const h = Math.abs(box.y1 - box.y0);
    ctx.fillStyle = "rgba(216,180,92,0.12)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "rgba(216,180,92,0.85)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.setLineDash([]);
  }

  // -- picking --------------------------------------------------------------

  bindingAt(match: Match, px: number, py: number): Binding | null {
    for (let i = this.banners.length - 1; i >= 0; i -= 1) {
      const chit = this.banners[i];
      if (!chit) continue;
      if (px < chit.x - 4 || px > chit.x + chit.w + 4) continue;
      if (py < chit.y - 12 || py > chit.y + chit.h + 4) continue;
      return match.bindingByName(chit.name) ?? null;
    }
    // Nothing on a banner: fall back to whoever is standing near the point.
    let best: Binding | null = null;
    let bestDistance = 26 * 26;
    for (const binding of match.bindings.values()) {
      for (const unit of match.bindingUnits(binding)) {
        if (binding.side !== "player" && !this.canSee(match, unit)) continue;
        const at = this.board.screenOf(unit);
        if (at.behind) continue;
        const d = (at.x - px) ** 2 + (at.y - py) ** 2;
        if (d >= bestDistance) continue;
        bestDistance = d;
        best = binding;
      }
    }
    return best;
  }

  structureAt(match: Match, cell: Cell): Structure | null {
    for (const structure of match.structures.values()) {
      const reach = structure.span;
      if (Math.abs(structure.cell.x - cell.x) <= reach && Math.abs(structure.cell.y - cell.y) <= reach) {
        return structure;
      }
    }
    return null;
  }

  bindingsIn(match: Match, box: Marquee): Binding[] {
    const x0 = Math.min(box.x0, box.x1);
    const x1 = Math.max(box.x0, box.x1);
    const y0 = Math.min(box.y0, box.y1);
    const y1 = Math.max(box.y0, box.y1);
    const found = new Set<Binding>();
    for (const binding of match.bindings.values()) {
      for (const unit of match.bindingUnits(binding)) {
        const at = this.board.screenOf(unit);
        if (at.behind) continue;
        if (at.x < x0 || at.x > x1 || at.y < y0 || at.y > y1) continue;
        found.add(binding);
        break;
      }
    }
    return [...found];
  }
}
