import {
  BASE_COST, BAYONET_SPEED, CAPTURE_TILES, DEFAULT_TIME_S, DEPOT_CAPTURE_S,
  DEPOT_YIELD, WORK_MIN_SPACING_TILES, WORK_REACH_TILES, GRADE_COST,
  ARTILLERY_SIEGE_HIT, HIGH_GROUND_M, HP, ID_MEDIUM_TILES, ID_NEAR_TILES, isWork,
  LANCE_SPEED, MAIN_YIELD, MELEE_RANGE, NATO_NAMES, RECRUIT_TIME_S, SIEGE_DPS,
  SIGHT_TILES, SPAN, START_SUPPLY, SUPPLY_INTERVAL_S, TILE_M, WORKS, WORK_TRADE, type WorkKind,
} from "./constants";
import { hasLos } from "./los";
import { DEFAULT_FIELD_AREA, FIELD_SIZES, mapById } from "./maps";
import { findPath } from "./path";
import { coolRules, fireOrders, makeRule, readThreshold, type ActorRef, type Naming, type RuleWorld } from "./rules";
import { frontage, worldSlots } from "./shapes";
import {
  bank, buildControl, incomeOf, routeHome, type ControlField,
} from "./supply";
import {
  baseSpeed, blocksShot, cellCenter, cellOf, artilleryBlast, artilleryReload, heightAt,
  inBounds, limberSpeed, musketCone, musketRange, musketReload, speedScale,
  terrainAt, walkable,
} from "./terrain";
import type {
  ActionKind, Alert, Binding, Cell, CommandResult, Contact, ContactBand,
  GameEvent, Load, OrderKind, Owner, Phase, Priority, ProductionOrder,
  Projectile, Quality, Report, ResultKind, Rule, SequenceStep, Settings, Trigger,
  Shape, Side, StandingOrder, Structure, Unit, UnitType, WorldMap,
} from "./types";

const fail = (code: string, message: string, details?: unknown): CommandResult<never> =>
  ({ ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } });
const ok = <T>(data: T): CommandResult<T> => ({ ok: true, data });

const other = (side: Side): Side => (side === "player" ? "enemy" : "player");

/** How much of its own dispatch traffic each side keeps. */
const ALERTS_PER_SIDE = 90;

/** What the enemy that set a watch off is called, given what the watch was. */
const ATTACKER_TEXT: Partial<Record<Trigger, string>> = {
  under_fire: "the attacker",
  spotted: "the enemy it sighted",
  threatened: "the enemy at its gate",
};

const defaultOrder = (cell: Cell): StandingOrder => ({
  kind: "hold",
  cells: [cell],
  holdFire: false,
  fireAtWill: true,
  engageRange: 95,
  priority: "nearest",
  load: "round",
  sequence: [],
  sequenceIndex: 0,
  waitLeft: 0,
  setAt: 0,
});

/** The pull a round feels. Gentle, so a ball still carries a battlefield. */
const GRAVITY = 3.4;

/** Longest reach of a field piece, and the closest it will lay a ball. */
const ARTILLERY_RANGE = 380;
/** Men a single round shot can take. A ball ploughs a file, not a square. */
const BALL_FILE = 4;
/** Seconds a trooper needs to ride clear and come round again. */
const MELEE_RECOVER_S = 2.6;
/** The odds a man ridden down takes the horseman with him. */
const MELEE_ANSWER = 0.42;
export const ARTILLERY_MIN_RANGE = 26;

export const unitCost = (type: UnitType, grade: Quality) =>
  Math.round(BASE_COST[type] * (GRADE_COST[grade] ?? 1));

const recruitSeconds = (type: UnitType, grade: Quality, count: number) =>
  RECRUIT_TIME_S[type] * count * (GRADE_COST[grade] ?? 1);

/**
 * What a shed does for the arm it serves.
 *
 * A barracks is 220 crates that only pays for itself in cheaper, faster
 * infantry -- it has no yield of its own -- and it pays more when it stands on
 * the ground it wants. Multiplies both the bill and the time, so a work is a
 * decision about what you intend to raise rather than a flat tax.
 */
export const tradeRate = (structure: Structure, type: UnitType) => {
  if (!isWork(structure.kind)) return 1;
  if (WORK_TRADE[structure.kind as WorkKind] !== type) return 1;
  return structure.sited ? 0.65 : 0.78;
};

/**
 * The whole game.
 *
 * One continuous battle: no shop, no deploy, no commander on the field. Each
 * side owns a main base that pays a trickle of crates, and everything beyond
 * that trickle has to be taken and kept connected. Formations are named
 * bindings that carry a standing order; the rule book turns events into new
 * standing orders without the player touching anything.
 */
export class Match {
  settings: Settings;
  phase: Phase = "boot";
  world: WorldMap;
  supply: Record<Side, number> = { player: START_SUPPLY, enemy: START_SUPPLY };
  income: Record<Side, number> = { player: MAIN_YIELD, enemy: MAIN_YIELD };
  units = new Map<string, Unit>();
  bindings = new Map<string, Binding>();
  structures = new Map<string, Structure>();
  production: ProductionOrder[] = [];
  rules: Rule[] = [];
  alerts: Alert[] = [];
  projectiles: Projectile[] = [];
  clock = 0;
  paused = false;
  result: ResultKind = null;
  nextId = 1;
  nextName = 0;
  enemyName = 0;
  botAccum = 0;
  /** Running tally of bayonet and lance kills, so the board can sound them. */
  melee = 0;
  /** Muzzle events since the view last drained them. Read with takeReports(). */
  private reports: Report[] = [];
  private supplyAccum = SUPPLY_INTERVAL_S;
  private control: Record<Side, ControlField | null> = { player: null, enemy: null };
  private routes = new Map<string, { goal: Cell; path: Cell[] }>();

  constructor(settings?: Partial<Settings>) {
    this.settings = {
      timeLimitS: settings?.timeLimitS ?? DEFAULT_TIME_S,
      mapId: settings?.mapId ?? "village",
      mapArea: settings?.mapArea ?? DEFAULT_FIELD_AREA,
      difficulty: settings?.difficulty ?? 2,
    };
    this.world = mapById(this.settings.mapId, this.settings.mapArea);
  }

  id(prefix: string) {
    const value = `${prefix}${this.nextId}`;
    this.nextId += 1;
    return value;
  }

  nextBindingName(side: Side = "player"): string {
    if (side === "enemy") {
      const name = `Red-${NATO_NAMES[this.enemyName % NATO_NAMES.length] ?? this.enemyName}`;
      this.enemyName += 1;
      return name;
    }
    const name = NATO_NAMES[this.nextName % NATO_NAMES.length] ?? `Force${this.nextName}`;
    this.nextName += 1;
    if ([...this.bindings.values()].some((binding) => binding.name === name)) return this.nextBindingName(side);
    return name;
  }

  living(side?: Side) {
    return [...this.units.values()].filter((unit) => unit.alive && (side ? unit.side === side : true));
  }

  bindingUnits(binding: Binding) {
    return binding.unitIds.map((id) => this.units.get(id)).filter((unit): unit is Unit => Boolean(unit?.alive));
  }

  bindingByName(name: string) {
    return [...this.bindings.values()].find((binding) => binding.name === name);
  }

  structuresOf(side: Owner) {
    return [...this.structures.values()].filter((structure) => structure.side === side);
  }

  mainOf(side: Side) {
    return [...this.structures.values()].find((structure) => structure.kind === "main" && structure.side === side);
  }

  /**
   * Where a formation is, in metres.
   *
   * The median of its men, not the mean. This is the single most consequential
   * line in the movement code: the formation's position is what decides how
   * far along its route it has got, and with a mean, three stragglers caught
   * on a wall hold two dozen men who have already reached the next waypoint.
   * The formation then never advances, its route never progresses, and it
   * stands there for the rest of the battle -- which is exactly what it did.
   * A median ignores the stragglers, the body of the formation gets on, and
   * the men behind catch up.
   */
  bindingAt(binding: Binding): { x: number; z: number } {
    const members = this.bindingUnits(binding);
    if (!members.length) return { x: 0, z: 0 };
    const mid = (values: number[]) => {
      values.sort((a, b) => a - b);
      const half = values.length >> 1;
      return values.length % 2
        ? values[half] as number
        : ((values[half - 1] as number) + (values[half] as number)) / 2;
    };
    return {
      x: mid(members.map((unit) => unit.x)),
      z: mid(members.map((unit) => unit.z)),
    };
  }

  bindingCell(binding: Binding): Cell {
    const members = this.bindingUnits(binding);
    if (!members.length) return { x: 0, y: 0 };
    const at = this.bindingAt(binding);
    return cellOf(at.x, at.z);
  }

  // -- setup ---------------------------------------------------------------

  setSettings(patch: Partial<Settings>): CommandResult {
    if (this.phase !== "boot") return fail("wrong_phase", "Settings can only change before the battle opens.");
    if (patch.timeLimitS !== undefined) this.settings.timeLimitS = Math.max(180, Math.min(3600, Math.round(patch.timeLimitS)));
    if (patch.difficulty !== undefined) this.settings.difficulty = patch.difficulty;
    if (patch.mapArea !== undefined) {
      const wanted = FIELD_SIZES.find((size) => size.area === patch.mapArea);
      if (!wanted) return fail("bad_field_size", "Field size must be one of the offered sizes.");
      this.settings.mapArea = wanted.area;
    }
    if (patch.mapId) this.settings.mapId = patch.mapId;
    if (patch.mapId || patch.mapArea !== undefined) {
      this.world = mapById(this.settings.mapId, this.settings.mapArea);
    }
    return ok(this.settings);
  }

  private addStructure(kind: Structure["kind"], side: Owner, cell: Cell, name: string, build = 1): Structure {
    const work = isWork(kind) ? WORKS[kind] : null;
    const sited = isWork(kind) ? this.wellSited(kind, cell) : false;
    const plain = isWork(kind) ? null : (kind as "main" | "depot");
    const maxHp = work ? (sited ? work.hp * work.boon : work.hp) : HP[plain!];
    const structure: Structure = {
      id: this.id(kind === "main" ? "base" : kind === "depot" ? "dep" : kind),
      kind,
      side,
      name,
      cell,
      span: work ? work.span : SPAN[plain!],
      hp: maxHp * build,
      maxHp,
      build,
      yield: work ? work.yield : plain === "main" ? MAIN_YIELD : DEPOT_YIELD,
      connected: kind === "main",
      route: [],
      capture: 0,
      capturingSide: "neutral",
      rally: this.freeCellNear(cell, kind === "main" ? 3 : 2),
      sited,
      cutLatch: false,
      threatLatch: false,
      hurtAccum: 0,
    };
    this.structures.set(structure.id, structure);
    return structure;
  }

  private freeCellNear(cell: Cell, radius: number): Cell {
    for (let r = radius; r <= radius + 4; r += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const at = { x: cell.x + dx, y: cell.y + dy };
          if (!inBounds(this.world, at.x, at.y)) continue;
          if (walkable(terrainAt(this.world, at.x, at.y))) return at;
        }
      }
    }
    return cell;
  }

  /** Open the field: bases, depots, and a garrison each. */
  start(): CommandResult {
    if (this.phase === "battle") return ok({ phase: this.phase });
    this.units.clear();
    this.bindings.clear();
    this.structures.clear();
    this.production = [];
    this.projectiles = [];
    this.alerts = [];
    this.clock = 0;
    this.result = null;
    this.paused = false;
    this.supply = { player: START_SUPPLY, enemy: START_SUPPLY };
    this.nextName = 0;
    this.enemyName = 0;

    this.addStructure("main", "player", this.world.mainCells.player, "Headquarters");
    this.addStructure("main", "enemy", this.world.mainCells.enemy, "Enemy Headquarters");
    this.world.depotCells.forEach((cell, index) => {
      this.addStructure("depot", "neutral", cell, `Depot ${index + 1}`);
    });

    for (const side of ["player", "enemy"] as const) {
      const main = this.mainOf(side);
      if (!main) continue;
      // Drawn up in front of the works and facing the field, not stacked on
      // the gate. Two battalions forward with the horse held between them.
      //
      // Faced along the line between the two headquarters rather than due
      // east: the fields are no longer all fought left to right, and on a
      // field with its axis running north the old fixed offset drew the whole
      // army up sideways.
      const foe = this.world.mainCells[side === "player" ? "enemy" : "player"];
      const span = Math.max(1, Math.hypot(foe.x - main.cell.x, foe.y - main.cell.y));
      const fx = (foe.x - main.cell.x) / span;
      const fy = (foe.y - main.cell.y) / span;
      const at = (ahead: number, along: number): Cell => ({
        x: Math.round(main.cell.x + fx * ahead - fy * along),
        y: Math.round(main.cell.y + fy * ahead + fx * along),
      });
      this.garrison(side, main, "infantry", 24, 2, at(3, -4));
      this.garrison(side, main, "infantry", 24, 2, at(3, 4));
      this.garrison(side, main, "cavalry", 10, 2, at(2, 0));
    }
    this.seedRules();
    this.phase = "battle";
    this.refreshSupply();
    return ok({ phase: this.phase });
  }

  /** Spawn a formation immediately, used for opening garrisons and the bot. */
  garrison(side: Side, at: Structure, type: UnitType, count: number, grade: Quality, where?: Cell) {
    const cell = where ? this.onMap(where) : this.freeCellNear(at.cell, at.span + 1);
    return this.formUp(side, cell, type, count, grade);
  }

  /** Keep a cell inside the field, with room for a line to deploy either side. */
  private onMap(cell: Cell): Cell {
    return {
      x: Math.max(3, Math.min(this.world.width - 4, cell.x)),
      y: Math.max(2, Math.min(this.world.height - 3, cell.y)),
    };
  }

  private formUp(side: Side, cell: Cell, type: UnitType, count: number, grade: Quality): Binding {
    const facing = side === "player" ? 0 : Math.PI;
    const binding = this.createBinding(side, [], type === "artillery" ? "line" : "line", type === "artillery" ? 4.2 : 2.2, facing, cell);
    const origin = cellCenter(cell);
    const slots = worldSlots(origin, binding.shape, count, binding.spacing, facing);
    slots.forEach((slot, index) => {
      const unit = this.spawn({
        side,
        type,
        weapon: grade,
        powder: grade,
        calibre: grade,
        x: slot.x,
        z: slot.z,
        heading: facing,
        bindingId: binding.id,
        slot: index,
      });
      binding.unitIds.push(unit.id);
    });
    binding.establishment = binding.unitIds.length;
    binding.lastStrength = binding.unitIds.length;
    return binding;
  }

  spawn(partial: Omit<Unit, "id" | "y" | "speed" | "alive" | "reload">) {
    const unit: Unit = {
      id: this.id("u"),
      y: heightAt(this.world, partial.x, partial.z) + 0.95,
      speed: 0,
      alive: true,
      reload: 0,
      ...partial,
    };
    this.units.set(unit.id, unit);
    return unit;
  }

  createBinding(side: Side, unitIds: string[], shape: Shape, spacing: number, facing: number, hold = { x: 0, y: 0 }): Binding {
    const binding: Binding = {
      id: this.id("b"),
      name: this.nextBindingName(side),
      side,
      unitIds,
      shape,
      spacing,
      facing,
      order: defaultOrder(hold),
      establishment: unitIds.length,
      lastStrength: unitIds.length,
      hurtAccum: 0,
      hurtSaidAt: -99,
      arrived: false,
      weakLatch: false,
      contactLatch: false,
      stallS: 0,
      mark: { x: 0, z: 0 },
    };
    this.bindings.set(binding.id, binding);
    unitIds.forEach((id) => {
      const unit = this.units.get(id);
      if (unit) unit.bindingId = binding.id;
    });
    return binding;
  }

  /**
   * Two orders every commander would have written anyway.
   *
   * Both name something the player can point at -- the first battalion of the
   * line and the headquarters -- because an order that fires on "any
   * formation" is an order nobody can predict.
   */
  private seedRules() {
    const first = [...this.bindings.values()].find((binding) => binding.side === "player");
    const main = this.mainOf("player");
    this.rules = [];
    if (first) {
      this.rules.push(makeRule(this.id("r"), "player", {
        watch: { kind: "binding", ref: first.name },
        trigger: "weakened",
        threshold: 35,
        actor: { kind: "binding", ref: first.name },
        action: "retreat",
        cooldownS: 45,
      }));
    }
    if (main) {
      this.rules.push(makeRule(this.id("r"), "player", {
        watch: { kind: "chest" },
        trigger: "supply_above",
        threshold: 1200,
        actor: { kind: "structure", ref: main.id },
        action: "recruit",
        unitType: "infantry",
        count: 12,
        cooldownS: 30,
      }));
    }
  }

  // -- economy -------------------------------------------------------------

  recruit(side: Side, structureId: string, type: UnitType, count: number, grade: Quality = 2): CommandResult<ProductionOrder> {
    if (this.phase !== "battle") return fail("wrong_phase", "Recruiting happens during the battle.");
    const structure = this.structures.get(structureId);
    if (!structure || structure.side !== side) return fail("no_base", "No friendly base with that id.");
    if (structure.build < 1) return fail("unfinished", `${structure.name} is still being built.`);
    if (!structure.connected) return fail("out_of_supply", `${structure.name} is cut off and cannot raise men.`);
    const n = Math.max(1, Math.min(120, Math.round(count)));
    const rate = tradeRate(structure, type);
    const bill = Math.round(unitCost(type, grade) * n * rate);
    if (this.supply[side] < bill) return fail("not_enough_supply", `Need ${bill} crates, have ${Math.floor(this.supply[side])}.`);
    this.supply[side] -= bill;
    const totalS = recruitSeconds(type, grade, n) * rate;
    const order: ProductionOrder = {
      id: this.id("q"),
      side,
      structureId,
      type,
      grade,
      count: n,
      totalS,
      leftS: totalS,
      bindingName: "",
    };
    this.production.push(order);
    return ok(order);
  }

  /** Every reason a redoubt cannot go here, without building one. */
  /**
   * Does this cell touch the ground the work wants?
   *
   * Checked over the eight neighbours and the cell itself, so a foundry only
   * has to back onto woods rather than stand in them.
   */
  private wellSited(kind: WorkKind, cell: Cell): boolean {
    const wants = WORKS[kind].wants;
    const here = heightAt(this.world, cell.x, cell.y);
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = cell.x + dx;
        const y = cell.y + dy;
        if (!inBounds(this.world, x, y)) continue;
        if (wants.terrain && terrainAt(this.world, x, y) === wants.terrain) return true;
      }
    }
    return Boolean(wants.highGround && here >= HIGH_GROUND_M);
  }

  canBuild(side: Side, kind: WorkKind, cell: Cell): CommandResult<{ cost: number; sited: boolean }> {
    const work = WORKS[kind];
    if (this.phase !== "battle") return fail("wrong_phase", "Building happens during the battle.");
    if (!inBounds(this.world, cell.x, cell.y)) return fail("out_of_bounds", "That is off the map.");
    if (!walkable(terrainAt(this.world, cell.x, cell.y))) return fail("blocked", `A ${work.name.toLowerCase()} needs open ground.`);
    if (this.supply[side] < work.cost) return fail("not_enough_supply", `Need ${work.cost} crates, have ${Math.floor(this.supply[side])}.`);
    const near = this.structuresOf(side).some((structure) => structure.connected && this.tileGap(structure.cell, cell) <= WORK_REACH_TILES);
    if (!near) return fail("out_of_reach", `A ${work.name.toLowerCase()} must be within ${WORK_REACH_TILES} tiles of a work that is in supply.`);
    const crowded = [...this.structures.values()].some((structure) => this.tileGap(structure.cell, cell) < WORK_MIN_SPACING_TILES);
    if (crowded) return fail("too_close", `Keep works ${WORK_MIN_SPACING_TILES} tiles apart.`);
    if (this.control[side]?.blocked[cell.y * this.world.width + cell.x]) return fail("contested", "The enemy holds that ground.");
    return ok({ cost: work.cost, sited: this.wellSited(kind, cell) });
  }

  build(side: Side, kind: WorkKind, cell: Cell): CommandResult<Structure> {
    const check = this.canBuild(side, kind, cell);
    if (!check.ok) return check;
    const work = WORKS[kind];
    this.supply[side] -= work.cost;
    const built = this.structuresOf(side).filter((structure) => structure.kind === kind).length;
    const structure = this.addStructure(kind, side, cell, built ? `${work.name} ${built + 1}` : work.name, 0);
    structure.hp = structure.maxHp * 0.15;
    return ok(structure);
  }

  private tileGap(a: Cell, b: Cell) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /**
   * The war chest reports as it crosses a figure, not on a sweep: an order
   * written against it goes out on the crate that passes the mark.
   */
  private tickChest(side: Side, before: number, after: number) {
    if (after <= before) return;
    const main = this.mainOf(side);
    for (const rule of this.rules) {
      if (rule.side !== side || !rule.enabled || rule.trigger !== "supply_above") continue;
      if (rule.threshold <= before || rule.threshold > after) continue;
      this.emit({
        side,
        event: "supply_above",
        subjectKind: "chest",
        subjectId: "chest",
        subjectName: "The war chest",
        cell: main?.cell ?? { x: 0, y: 0 },
        eventCell: main?.cell ?? { x: 0, y: 0 },
        text: `The war chest has passed ${Math.round(rule.threshold)} crates.`,
      });
    }
  }

  private tickEconomy(dt: number) {
    for (const side of ["player", "enemy"] as const) {
      this.income[side] = incomeOf(this.structures.values(), side);
      const before = this.supply[side];
      this.supply[side] = bank(before, (this.income[side] / 60) * dt);
      this.tickChest(side, before, this.supply[side]);
    }
    for (const structure of this.structures.values()) {
      if (structure.build >= 1) continue;
      const buildS = isWork(structure.kind) ? WORKS[structure.kind].buildS : 22;
      structure.build = Math.min(1, structure.build + dt / buildS);
      structure.hp = Math.max(structure.hp, structure.maxHp * (0.15 + structure.build * 0.85));
    }
    const done: ProductionOrder[] = [];
    for (const order of this.production) {
      order.leftS -= dt;
      if (order.leftS <= 0) done.push(order);
    }
    if (!done.length) return;
    this.production = this.production.filter((order) => !done.includes(order));
    for (const order of done) {
      const structure = this.structures.get(order.structureId);
      const cell = structure ? structure.rally : this.world.mainCells[order.side];
      const binding = this.formUp(order.side, cell, order.type, order.count, order.grade);
      order.bindingName = binding.name;
      this.emit({
        side: order.side,
        event: "idle",
        subjectKind: "binding",
        subjectId: binding.id,
        subjectName: binding.name,
        cell,
        eventCell: cell,
        text: `${binding.name} has formed up at ${structure?.name ?? "the base"}.`,
      });
    }
  }

  // -- supply --------------------------------------------------------------

  refreshSupply() {
    for (const side of ["player", "enemy"] as const) {
      this.control[side] = buildControl(this.world, side, this.units.values(), this.structures.values());
    }
    for (const structure of this.structures.values()) {
      if (structure.side === "neutral") {
        structure.connected = false;
        structure.route = [];
        continue;
      }
      const side = structure.side;
      if (structure.kind === "main") {
        structure.connected = true;
        structure.route = [];
        continue;
      }
      const main = this.mainOf(side);
      const control = this.control[side];
      const route = main && control ? routeHome(this.world, structure.cell, main.cell, control) : null;
      const was = structure.connected;
      structure.connected = Boolean(route);
      structure.route = route ?? [];
      if (was && !structure.connected && !structure.cutLatch) {
        structure.cutLatch = true;
        this.emit({
          side,
          event: "supply_cut",
          subjectKind: "structure",
          subjectId: structure.id,
          subjectName: structure.name,
          cell: structure.cell,
          eventCell: structure.cell,
          text: `${structure.name} has lost its supply line.`,
        });
      }
      if (!was && structure.connected && structure.cutLatch) {
        structure.cutLatch = false;
        this.emit({
          side,
          event: "supply_restored",
          subjectKind: "structure",
          subjectId: structure.id,
          subjectName: structure.name,
          cell: structure.cell,
          eventCell: structure.cell,
          text: `${structure.name} is back in supply.`,
        });
      }
    }
  }

  controlField(side: Side) {
    return this.control[side];
  }

  // -- capture and siege ---------------------------------------------------

  private tickCapture(dt: number) {
    for (const structure of this.structures.values()) {
      if (structure.kind === "main") continue;
      const near = { player: 0, enemy: 0 };
      const centre = cellCenter(structure.cell);
      for (const unit of this.living()) {
        if (Math.hypot(unit.x - centre.x, unit.z - centre.z) > CAPTURE_TILES * TILE_M) continue;
        near[unit.side] += 1;
      }
      const holder: Owner = near.player && !near.enemy ? "player" : near.enemy && !near.player ? "enemy" : "neutral";
      if (holder === "neutral" || holder === structure.side) {
        structure.capture = Math.max(0, structure.capture - dt / DEPOT_CAPTURE_S);
        if (structure.capture === 0) structure.capturingSide = "neutral";
        continue;
      }
      if (structure.capturingSide !== holder) {
        structure.capturingSide = holder;
        structure.capture = 0;
      }
      structure.capture += dt / DEPOT_CAPTURE_S;
      if (structure.capture < 1) continue;
      const lostBy = structure.side;
      structure.capture = 0;
      structure.capturingSide = "neutral";
      structure.side = holder;
      structure.build = 1;
      structure.hp = Math.max(structure.hp, structure.maxHp * 0.5);
      structure.cutLatch = false;
      this.emit({
        side: holder,
        event: "captured",
        subjectKind: "structure",
        subjectId: structure.id,
        subjectName: structure.name,
        cell: structure.cell,
        eventCell: structure.cell,
        text: `${structure.name} is ours.`,
      });
      if (lostBy !== "neutral") {
        this.emit({
          side: lostBy,
          event: "lost",
          subjectKind: "structure",
          subjectId: structure.id,
          subjectName: structure.name,
          cell: structure.cell,
          eventCell: structure.cell,
          text: `${structure.name} has fallen.`,
        });
      }
    }
  }

  private tickSiege(dt: number) {
    for (const structure of this.structures.values()) {
      if (structure.side === "neutral" || structure.kind === "depot") continue;
      const centre = cellCenter(structure.cell);
      const reach = (structure.span * 0.5 + 0.9) * TILE_M;
      let damage = 0;
      for (const unit of this.living()) {
        if (unit.side === structure.side) continue;
        if (Math.hypot(unit.x - centre.x, unit.z - centre.z) > reach) continue;
        damage += SIEGE_DPS[unit.type];
      }
      if (damage <= 0) continue;
      structure.hp -= damage * dt;
      structure.hurtAccum += damage * dt;
      if (structure.hurtAccum > structure.maxHp * 0.08 && !structure.threatLatch) {
        structure.threatLatch = true;
        this.emit({
          side: structure.side,
          event: "threatened",
          subjectKind: "structure",
          subjectId: structure.id,
          subjectName: structure.name,
          cell: structure.cell,
          eventCell: structure.cell,
          text: `${structure.name} is under assault.`,
        });
      }
      if (structure.hp <= 0) this.razeStructure(structure);
    }
  }

  private razeStructure(structure: Structure) {
    const side = structure.side;
    this.structures.delete(structure.id);
    if (side === "neutral") return;
    this.emit({
      side,
      event: "destroyed",
      subjectKind: "structure",
      subjectId: structure.id,
      subjectName: structure.name,
      cell: structure.cell,
      eventCell: structure.cell,
      text: `${structure.name} has been destroyed.`,
    });
    this.production = this.production.filter((order) => order.structureId !== structure.id);
    if (structure.kind === "main") this.finish(side === "player" ? "lose" : "win");
  }

  /** A round that lands on a structure hurts it. Called from the projectile step. */
  private shellStructure(x: number, z: number, radius: number) {
    for (const structure of this.structures.values()) {
      if (structure.kind === "depot") continue;
      const centre = cellCenter(structure.cell);
      if (Math.hypot(centre.x - x, centre.z - z) > radius + structure.span * TILE_M * 0.5) continue;
      structure.hp -= ARTILLERY_SIEGE_HIT;
      if (structure.hp <= 0) this.razeStructure(structure);
    }
  }

  // -- events and the rule book --------------------------------------------

  /**
   * A report goes straight to the orders written against the thing that raised
   * it. Nothing is queued and nothing is swept: the order is part of the
   * formation, and it goes out in the same instant the report does.
   */
  emit(event: GameEvent) {
    fireOrders(this.rules, event, this.ruleWorld());
  }

  /**
   * What a standing order's nouns are called.
   *
   * The book, the order card, the dispatches and the WebMCP tools all read an
   * order through this, so the player and an agent see the same words for the
   * same formation.
   */
  naming(): Naming {
    const formation = (ref: string) => this.bindingByName(ref)?.name ?? ref ?? "a formation";
    const base = (ref: string) => this.structures.get(ref)?.name ?? "a base";
    return {
      watched: (watch) => watch.kind === "chest"
        ? "the war chest"
        : watch.kind === "binding" ? formation(watch.ref) : base(watch.ref),
      actor: (actor) => actor.kind === "binding" ? formation(actor.ref) : base(actor.ref),
      place: (place, trigger) => {
        switch (place.kind) {
          case "attacker": return ATTACKER_TEXT[trigger] ?? "the enemy";
          case "binding": return formation(place.ref);
          case "structure": return base(place.ref);
          default: return `the ground at ${place.cell.x},${place.cell.y}`;
        }
      },
    };
  }

  private ruleWorld(): RuleWorld {
    const refOfBinding = (binding: Binding): ActorRef => ({ kind: "binding", id: binding.id, name: binding.name });
    return {
      name: this.naming(),
      bindingByName: (name) => {
        const binding = this.bindingByName(name);
        return binding ? refOfBinding(binding) : null;
      },
      structureById: (id) => {
        const structure = this.structures.get(id);
        return structure ? { kind: "structure", id: structure.id, name: structure.name } : null;
      },
      cellOfActor: (ref) => {
        if (ref.kind === "structure") return this.structures.get(ref.id)?.cell ?? { x: 0, y: 0 };
        const binding = this.bindings.get(ref.id);
        return binding ? this.bindingCell(binding) : { x: 0, y: 0 };
      },
      perform: (ref, action, cells, unitType, count) => this.performAction(ref, action, cells, unitType, count),
      emitAlert: (alert) => {
        // Trim per side, not overall. One flat cap let the opposing staff's
        // traffic -- which the player never reads -- evict the player's own
        // dispatches, so a sighting or a cut supply line vanished from the
        // feed behind a hundred of the enemy's formations reporting in.
        this.alerts.unshift({ id: this.id("a"), ...alert });
        let kept = 0;
        for (let i = 0; i < this.alerts.length; i += 1) {
          const item = this.alerts[i];
          if (!item || item.side !== alert.side) continue;
          kept += 1;
          if (kept > ALERTS_PER_SIDE) {
            this.alerts.splice(i, 1);
            i -= 1;
          }
        }
      },
      clock: this.clock,
    };
  }

  private performAction(
    ref: ActorRef,
    action: ActionKind,
    cells: Cell[],
    unitType: UnitType,
    count: number,
  ): string | null {
    const where = cells[0];
    if (action === "recruit") {
      if (ref.kind !== "structure") return null;
      const structure = this.structures.get(ref.id);
      if (!structure || structure.side === "neutral") return null;
      const made = this.recruit(structure.side, structure.id, unitType, count);
      return made.ok ? `${structure.name} is raising ${count} ${unitType}.` : null;
    }
    if (ref.kind !== "binding") return null;
    const binding = this.bindings.get(ref.id);
    if (!binding) return null;
    const result = this.issue(binding.name, { order: action as OrderKind, cells: where ? [where] : undefined }, binding.side);
    if (!result.ok) return null;
    return where
      ? `${binding.name} ordered to ${action.replace("_", " ")} at ${where.x},${where.y}.`
      : `${binding.name} ordered to ${action.replace("_", " ")}.`;
  }

  /** Watch every formation for the things the book can react to. */
  private tickBindingEvents(dt: number) {
    for (const binding of this.bindings.values()) {
      const members = this.bindingUnits(binding);
      const strength = members.length;
      if (!strength) continue;
      const cell = this.bindingCell(binding);

      if (strength < binding.lastStrength) {
        binding.hurtAccum += binding.lastStrength - strength;
      }
      binding.lastStrength = strength;
      binding.establishment = Math.max(binding.establishment, strength);

      /**
       * One casualty report at a time, with the count in it.
       *
       * The threshold is two men, which a battalion under close volley loses
       * several times in a single second -- so the feed filled with four
       * identical lines a tick and nothing else could be read. Held to one
       * report every eight seconds, which also lets it say how many are down
       * instead of that some are.
       */
      const badly = Math.max(2, binding.establishment * 0.08);
      if (binding.hurtAccum >= badly && this.clock - binding.hurtSaidAt >= 8) {
        const lost = Math.round(binding.hurtAccum);
        binding.hurtAccum = 0;
        binding.hurtSaidAt = this.clock;
        const foe = this.nearestVisibleFoe(binding);
        this.emit({
          side: binding.side,
          event: "under_fire",
          subjectKind: "binding",
          subjectId: binding.id,
          subjectName: binding.name,
          cell,
          eventCell: foe ?? cell,
          text: `${binding.name} has ${lost} ${lost === 1 ? "man" : "men"} down.`,
        });
      }

      const pct = (strength / Math.max(1, binding.establishment)) * 100;
      const weak = pct <= this.weakThreshold(binding);
      if (weak && !binding.weakLatch) {
        binding.weakLatch = true;
        this.emit({
          side: binding.side,
          event: "weakened",
          subjectKind: "binding",
          subjectId: binding.id,
          subjectName: binding.name,
          cell,
          eventCell: cell,
          text: `${binding.name} is down to ${Math.round(pct)}% of establishment.`,
        });
      }
      if (!weak) binding.weakLatch = false;

      /**
       * Arrival is reported once per order, not once per tile.
       *
       * The latch used to be cleared the moment the formation's centre drifted
       * off the goal cell -- which it does constantly, because that centre is
       * the mean of two dozen men shuffling in place. So a battalion standing
       * on its objective filed the same dispatch every few seconds and the
       * feed became nothing else. It is cleared when a new order is given
       * instead, which is the only time arriving is news again.
       */
      const goal = binding.order.cells[0];
      if (goal && !binding.arrived && goal.x === cell.x && goal.y === cell.y) {
        binding.arrived = true;
        const post = [...this.structures.values()]
          .find((s) => s.cell.x === goal.x && s.cell.y === goal.y);
        this.emit({
          side: binding.side,
          event: "arrived",
          subjectKind: "binding",
          subjectId: binding.id,
          subjectName: binding.name,
          cell,
          eventCell: cell,
          text: post
            ? `${binding.name} is in position at ${post.name}.`
            : `${binding.name} has reached its ground at ${goal.x},${goal.y}.`,
        });
      }

      // Contact is a rising edge with its own latch. It used to share the
      // arrival latch and fire only on a "hold" order, which meant a column on
      // the march never reported the enemy it was marching into, and a
      // formation that had reached its goal could never report at all.
      const foe = this.nearestVisibleFoe(binding);
      if (foe && !binding.contactLatch) {
        binding.contactLatch = true;
        this.emit({
          side: binding.side,
          event: "spotted",
          subjectKind: "binding",
          subjectId: binding.id,
          subjectName: binding.name,
          cell,
          eventCell: foe,
          text: `${binding.name} reports enemy at ${foe.x},${foe.y}.`,
        });
      }
      if (!foe) binding.contactLatch = false;
    }
    coolRules(this.rules, dt);
  }

  /**
   * The strength a formation reports itself cut down at.
   *
   * Whatever its own order says, so a battalion told to break off at a third
   * reports at a third and one told nothing reports at the usual mark.
   */
  private weakThreshold(binding: Binding) {
    const rule = this.rules.find((item) =>
      item.enabled && item.trigger === "weakened" && item.side === binding.side
      && item.watch.kind === "binding" && item.watch.ref === binding.name);
    return rule?.threshold ?? 45;
  }

  private nearestVisibleFoe(binding: Binding): Cell | null {
    const members = this.bindingUnits(binding);
    const scout = members[0];
    if (!scout) return null;
    let best: { cell: Cell; gap: number } | null = null;
    for (const foe of this.living(other(binding.side))) {
      const gap = Math.hypot(foe.x - scout.x, foe.z - scout.z);
      if (gap > SIGHT_TILES * TILE_M) continue;
      if (!hasLos(this.world, scout.x, scout.z, foe.x, foe.z)) continue;
      if (!best || gap < best.gap) best = { cell: cellOf(foe.x, foe.z), gap };
    }
    return best?.cell ?? null;
  }

  // -- rule book -----------------------------------------------------------

  addRule(side: Side, patch: Partial<Rule>): CommandResult<Rule> {
    if (this.rules.filter((rule) => rule.side === side).length >= 24) {
      return fail("book_full", "The standing-orders book holds 24 lines.");
    }
    const rule = makeRule(this.id("r"), side, patch);
    this.rules.push(rule);
    return ok(rule);
  }

  updateRule(id: string, patch: Partial<Rule>): CommandResult<Rule> {
    const rule = this.rules.find((item) => item.id === id);
    if (!rule) return fail("rule_not_found", "No rule with that id.");
    Object.assign(rule, patch, { id: rule.id, side: rule.side });
    rule.threshold = readThreshold(rule.trigger, rule.threshold);
    return ok(rule);
  }

  removeRule(id: string): CommandResult {
    const before = this.rules.length;
    this.rules = this.rules.filter((rule) => rule.id !== id);
    if (this.rules.length === before) return fail("rule_not_found", "No rule with that id.");
    return ok({ removed: id });
  }

  // -- orders --------------------------------------------------------------

  bind(side: Side, unitIds: string[], name?: string): CommandResult<Binding> {
    const units = unitIds.map((id) => this.units.get(id)).filter((unit): unit is Unit => Boolean(unit?.alive && unit.side === side));
    if (!units.length) return fail("no_units", "None of those unit ids are alive on your side.");
    if (name && this.bindingByName(name)) return fail("name_taken", `${name} already exists.`);
    for (const unit of units) {
      if (!unit.bindingId) continue;
      const old = this.bindings.get(unit.bindingId);
      if (old) old.unitIds = old.unitIds.filter((id) => id !== unit.id);
    }
    const binding = this.createBinding(side, units.map((unit) => unit.id), "line", 2.2, units[0]?.heading ?? 0, cellOf(units[0]!.x, units[0]!.z));
    if (name) binding.name = name;
    binding.establishment = binding.unitIds.length;
    binding.lastStrength = binding.unitIds.length;
    this.pruneBindings();
    return ok(binding);
  }

  unbind(name: string, side: Side = "player"): CommandResult {
    const binding = this.bindingByName(name);
    if (!binding || binding.side !== side) return fail("binding_not_found", `No binding named ${name}.`);
    for (const id of binding.unitIds) {
      const unit = this.units.get(id);
      if (unit) unit.bindingId = null;
    }
    this.bindings.delete(binding.id);
    return ok({ unbound: name });
  }

  renameBinding(from: string, to: string, side: Side = "player"): CommandResult<Binding> {
    const binding = this.bindingByName(from);
    if (!binding || binding.side !== side) return fail("binding_not_found", `No binding named ${from}.`);
    if (this.bindingByName(to)) return fail("name_taken", `${to} already exists.`);
    binding.name = to;
    return ok(binding);
  }

  pruneBindings() {
    // Deleting from a Map mid-iteration is legal, and the entry that was just
    // removed is the one we no longer want to visit. No snapshot needed.
    for (const [id, binding] of this.bindings) {
      if (this.bindingUnits(binding).length) continue;
      this.bindings.delete(id);
      this.emit({
        side: binding.side,
        event: "destroyed",
        subjectKind: "binding",
        subjectId: binding.id,
        subjectName: binding.name,
        cell: { x: 0, y: 0 },
        eventCell: { x: 0, y: 0 },
        text: `${binding.name} has been destroyed.`,
      });
    }
  }

  issue(name: string, patch: OrderPatch, side: Side = "player"): CommandResult<Binding> {
    const binding = this.bindingByName(name);
    if (!binding || binding.side !== side) return fail("binding_not_found", `No friendly binding named ${name}.`);
    const order = binding.order;
    if (patch.order) {
      order.kind = patch.order;
      order.setAt = this.clock;
      order.sequence = [];
      order.sequenceIndex = 0;
      order.waitLeft = 0;
      binding.arrived = false;
    }
    if (patch.cells) {
      order.cells = patch.cells;
      order.setAt = this.clock;
    }
    if (patch.holdFire !== undefined) order.holdFire = patch.holdFire;
    if (patch.fireAtWill !== undefined) order.fireAtWill = patch.fireAtWill;
    if (patch.engageRange !== undefined) order.engageRange = Math.max(10, Math.min(400, patch.engageRange));
    if (patch.priority) order.priority = patch.priority;
    if (patch.load) order.load = patch.load;
    if (patch.shape) binding.shape = patch.shape;
    if (patch.spacing !== undefined) binding.spacing = Math.max(1.2, Math.min(8, patch.spacing));
    if (patch.facing !== undefined) binding.facing = patch.facing;
    if (patch.faceCell) {
      const here = this.bindingCell(binding);
      binding.facing = Math.atan2(patch.faceCell.x - here.x, patch.faceCell.y - here.y);
    }
    if (patch.sequence) {
      order.sequence = patch.sequence;
      order.sequenceIndex = 0;
      order.waitLeft = patch.sequence[0]?.waitS ?? 0;
    }
    return ok(binding);
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    return ok({ paused });
  }

  // -- sight ---------------------------------------------------------------

  visibleTo(side: Side, target: Unit): { seen: boolean; band: ContactBand } {
    if (target.side === side) return { seen: true, band: "near" };
    const eyes = [
      ...this.living(side).map((unit) => ({ x: unit.x, z: unit.z })),
      ...this.structuresOf(side).map((structure) => {
        const centre = cellCenter(structure.cell);
        return { x: centre.x, z: centre.z };
      }),
    ];
    let best: ContactBand | null = null;
    for (const eye of eyes) {
      const tiles = Math.hypot(target.x - eye.x, target.z - eye.z) / TILE_M;
      if (tiles > ID_MEDIUM_TILES) continue;
      if (!hasLos(this.world, eye.x, eye.z, target.x, target.z)) continue;
      const band: ContactBand = tiles <= ID_NEAR_TILES ? "near" : "class";
      if (band === "near") return { seen: true, band };
      best = best ?? band;
    }
    return best ? { seen: true, band: best } : { seen: false, band: "unknown" };
  }

  contacts(side: Side): Contact[] {
    const buckets = new Map<string, { cell: Cell; band: ContactBand; types: Set<UnitType>; count: number }>();
    for (const unit of this.living(other(side))) {
      const sight = this.visibleTo(side, unit);
      if (!sight.seen) continue;
      const cell = cellOf(unit.x, unit.z);
      const key = `${cell.x},${cell.y}`;
      const bucket = buckets.get(key) ?? { cell, band: sight.band, types: new Set<UnitType>(), count: 0 };
      bucket.count += 1;
      if (sight.band !== "unknown") bucket.types.add(unit.type);
      if (sight.band === "near") bucket.band = "near";
      buckets.set(key, bucket);
    }
    return [...buckets.entries()].map(([key, bucket], index) => ({
      id: `c${index}-${key}`,
      band: bucket.band,
      class: bucket.types.size === 1 ? [...bucket.types][0] : bucket.types.size ? "mixed" : undefined,
      count: bucket.band === "near" ? bucket.count : undefined,
      cell: bucket.cell,
    }));
  }

  // -- tick ----------------------------------------------------------------

  tick(dt: number) {
    if (this.phase !== "battle" || this.paused || this.result) return;
    this.clock += dt;
    this.botAccum += dt;
    this.supplyAccum += dt;
    if (this.supplyAccum >= SUPPLY_INTERVAL_S) {
      this.supplyAccum = 0;
      this.refreshSupply();
    }
    this.tickEconomy(dt);
    this.advanceSequences(dt);
    this.moveBindings(dt);
    this.separateBodies();
    this.freeTrapped(dt);
    this.fireTick(dt);
    this.stepProjectiles(dt);
    this.meleeTick();
    this.tickCapture(dt);
    this.tickSiege(dt);
    this.pruneBindings();
    this.tickBindingEvents(dt);
    this.evaluateResult();
  }

  advanceSequences(dt: number) {
    for (const binding of this.bindings.values()) {
      const steps = binding.order.sequence;
      if (!steps.length) continue;
      binding.order.waitLeft -= dt;
      if (binding.order.waitLeft > 0) continue;
      const step = steps[binding.order.sequenceIndex];
      if (!step) {
        binding.order.sequence = [];
        continue;
      }
      binding.order.kind = step.order;
      if (step.cells.length) binding.order.cells = step.cells;
      if (step.holdFire !== undefined) binding.order.holdFire = step.holdFire;
      if (step.engageRange !== undefined) binding.order.engageRange = step.engageRange;
      if (step.load) binding.order.load = step.load;
      binding.order.sequenceIndex += 1;
      const next = steps[binding.order.sequenceIndex];
      binding.order.waitLeft = next?.waitS ?? 0;
      if (binding.order.sequenceIndex >= steps.length) binding.order.sequence = [];
    }
  }

  moveBindings(dt: number) {
    for (const binding of this.bindings.values()) {
      const members = this.bindingUnits(binding);
      if (!members.length) continue;
      const moving = binding.order.kind === "move" || binding.order.kind === "retreat"
        || binding.order.kind === "attack_area" || binding.order.kind === "charge";
      let origin = this.bindingAt(binding);
      let marching = binding.shape;
      /**
       * The stall watch.
       *
       * Ground and buildings make pockets a formation can wedge itself into,
       * and a wedged formation is the worst thing this game does: it looks
       * broken, because it is. So the distance made good is watched, and a
       * formation that has stopped making any is first narrowed to column and
       * then, if that is not enough, told to file through the gap -- every man
       * for the same point, dressing restored on the far side. That is what
       * troops do at a bridge, and it always clears.
       */
      if (moving) {
        const drift = Math.hypot(origin.x - binding.mark.x, origin.z - binding.mark.z);
        if (drift > 5) {
          binding.mark = { x: origin.x, z: origin.z };
          binding.stallS = 0;
        } else {
          binding.stallS += dt;
        }
      } else if (binding.stallS) {
        binding.stallS = 0;
      }
      if (moving && binding.order.cells[0]) {
        const goal = binding.order.cells[0];
        const here = cellOf(origin.x, origin.z);
        if (here.x === goal.x && here.y === goal.y) {
          if (binding.order.kind === "move") binding.order.kind = "hold";
        } else {
          // The formation forms up on the *next* cell of the route and walks
          // to it. Nudging the current centre a centimetre down the path, as
          // this once did, leaves a battalion shuffling in place for an hour.
          const step = this.waypoint(binding, here, goal);
          const next = cellCenter(step);
          binding.facing = Math.atan2(next.x - origin.x, next.z - origin.z);
          origin = next;
          marching = binding.stallS > 4 ? "column" : this.defile(binding, members.length, here, step);
        }
      }
      if (binding.order.kind === "charge") {
        const prey = this.pickTarget(members[0]!, binding, 220);
        if (prey) origin = { x: prey.x, z: prey.z };
      }
      if (moving && binding.stallS > 9) {
        // File through: three abreast at most, everyone for the same gap.
        const across = Math.cos(binding.facing);
        const along = -Math.sin(binding.facing);
        members.forEach((unit, index) => {
          const lane = ((index % 3) - 1) * binding.spacing;
          this.stepUnit(unit, origin.x + across * lane, origin.z + along * lane, dt, binding);
        });
        continue;
      }
      const slots = worldSlots(origin, marching, members.length, binding.spacing, binding.facing);
      members.forEach((unit, index) => {
        const slot = slots[index] ?? origin;
        this.stepUnit(unit, slot.x, slot.z, dt, binding);
      });
    }
  }

  /**
   * The shape a formation marches in, which is not always the shape it fights
   * in.
   *
   * A battalion in line is a hundred metres of frontage and will not go
   * through a ford, a bridge, or a village street. Real ones formed column for
   * the defile and shook back out into line beyond it, and so does this: the
   * player's chosen shape is untouched, only the ranks it walks in change.
   */
  private defile(binding: Binding, count: number, from: Cell, to: Cell): Shape {
    if (binding.shape === "column") return "column";
    const wanted = frontage(binding.shape, count, binding.spacing) / TILE_M;
    if (wanted <= 1.5) return binding.shape;
    const nx = -Math.sign(to.y - from.y);
    const ny = Math.sign(to.x - from.x);
    if (!nx && !ny) return binding.shape;
    // The formation is centred on its line of march, so what matters is the
    // room on *each* flank, not the total. Summing the two hands passed a gap
    // with a river down one side of it and jammed half the battalion in it.
    const half = wanted / 2;
    for (const hand of [1, -1]) {
      let clear = 0;
      for (let out = 1; out <= Math.ceil(half); out += 1) {
        const x = to.x + nx * out * hand;
        const y = to.y + ny * out * hand;
        if (!inBounds(this.world, x, y) || !walkable(terrainAt(this.world, x, y))) break;
        clear += 1;
      }
      if (clear < half) return "column";
    }
    return binding.shape;
  }

  /**
   * The next cell on the way to a goal, cached.
   *
   * A route only changes when the goal changes or the formation leaves the
   * one it was following, so pathing every formation on every one of twenty
   * ticks a second is wasted work. The cache also keeps a column committed to
   * one line of march instead of re-deciding under its own feet.
   */
  private waypoint(binding: Binding, here: Cell, goal: Cell): Cell {
    const held = this.routes.get(binding.id);
    const stale = !held
      || held.goal.x !== goal.x || held.goal.y !== goal.y
      || !held.path.some((cell) => cell.x === here.x && cell.y === here.y);
    if (stale) {
      const path = findPath(this.world, here, goal) ?? [here, goal];
      this.routes.set(binding.id, { goal, path });
      return path[1] ?? goal;
    }
    const at = held.path.findIndex((cell) => cell.x === here.x && cell.y === here.y);
    return held.path[at + 1] ?? goal;
  }

  stepUnit(unit: Unit, tx: number, tz: number, dt: number, binding: Binding) {
    const dx = tx - unit.x;
    const dz = tz - unit.z;
    const dist = Math.hypot(dx, dz);
    const charging = binding.order.kind === "charge";
    const limber = unit.type === "artillery" && (binding.order.kind === "move" || binding.order.kind === "retreat" || binding.order.kind === "charge");
    const kind = unit.type;
    const here = cellOf(unit.x, unit.z);
    const terrain = terrainAt(this.world, here.x, here.y);
    const max = (kind === "artillery" ? limberSpeed(unit.calibre) : baseSpeed(kind)) * speedScale(terrain, kind) * (charging ? 1.35 : 1);
    if (dist < 0.35) {
      unit.speed = Math.max(0, unit.speed - dt * 8);
      unit.x = tx;
      unit.z = tz;
    } else {
      /**
       * Walk the step, and if the ground will not take it, walk what part of
       * it the ground will.
       *
       * This used to drive straight at the slot and, on landing in a river,
       * shove the man back the way he came. A rank whose slots lie across a
       * stream then oscillates on the bank for the whole battle -- and because
       * a formation's position is the mean of its men, the formation itself
       * never advances a metre. Sliding along the obstacle instead lets a
       * battalion feel its way round a bank to the ford.
       */
      const step = Math.min(dist, max * dt);
      const ax = (dx / dist) * step;
      const az = (dz / dist) * step;
      const free = (x: number, z: number) => {
        const at = cellOf(x, z);
        return walkable(terrainAt(this.world, at.x, at.y));
      };
      if (free(unit.x + ax, unit.z + az)) {
        unit.x += ax;
        unit.z += az;
        unit.speed = max;
      } else if (free(unit.x + ax, unit.z)) {
        unit.x += ax;
        unit.speed = max * 0.6;
      } else if (free(unit.x, unit.z + az)) {
        unit.z += az;
        unit.speed = max * 0.6;
      } else {
        unit.speed = 0;
      }
      unit.heading = Math.atan2(dx, dz);
    }
    unit.y = heightAt(this.world, unit.x, unit.z) + (unit.type === "artillery" ? 0.7 : 0.95);
    if (limber) unit.reload = Math.max(unit.reload, 0.4);
  }

  separateBodies() {
    const bodies = this.living();
    for (let i = 0; i < bodies.length; i += 1) {
      for (let j = i + 1; j < bodies.length; j += 1) {
        const a = bodies[i]!;
        const b = bodies[j]!;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        const min = a.type === "artillery" || b.type === "artillery" ? 2.1 : 1.05;
        if (dist > 0 && dist < min) {
          const push = (min - dist) * 0.5;
          // Shove them apart, but not through a wall. This pass had no notion
          // of terrain, so a crowd at a village corner squeezed men into the
          // masonry, where nothing could reach their slot and the formation
          // they belonged to stopped for good.
          this.shove(a, -(dx / dist) * push, -(dz / dist) * push);
          this.shove(b, (dx / dist) * push, (dz / dist) * push);
          a.speed *= 0.72;
          b.speed *= 0.72;
        }
      }
    }
  }

  /** Move a body by a nudge, refusing any part of it that ends in a wall. */
  private shove(unit: Unit, dx: number, dz: number) {
    const clear = (x: number, z: number) => {
      const at = cellOf(x, z);
      return walkable(terrainAt(this.world, at.x, at.y));
    };
    if (clear(unit.x + dx, unit.z + dz)) {
      unit.x += dx;
      unit.z += dz;
      return;
    }
    if (clear(unit.x + dx, unit.z)) unit.x += dx;
    else if (clear(unit.x, unit.z + dz)) unit.z += dz;
  }

  /**
   * Get anyone standing in a wall out of it.
   *
   * Belt and braces for the separation pass: a man on unwalkable ground can
   * never reach his slot, and because a formation's position is the mean of
   * its men, one man in a wall drags the whole formation to a halt. Whatever
   * put him there, he walks to the nearest ground that will have him.
   */
  freeTrapped(dt: number) {
    for (const unit of this.living()) {
      const at = cellOf(unit.x, unit.z);
      if (walkable(terrainAt(this.world, at.x, at.y))) continue;
      let best: { x: number; z: number; gap: number } | null = null;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          if (!dx && !dy) continue;
          const x = at.x + dx;
          const y = at.y + dy;
          if (!inBounds(this.world, x, y) || !walkable(terrainAt(this.world, x, y))) continue;
          const to = cellCenter({ x, y });
          const gap = Math.hypot(to.x - unit.x, to.z - unit.z);
          if (!best || gap < best.gap) best = { x: to.x, z: to.z, gap };
        }
      }
      if (!best) continue;
      const step = Math.min(best.gap, baseSpeed(unit.type) * dt);
      unit.x += ((best.x - unit.x) / best.gap) * step;
      unit.z += ((best.z - unit.z) / best.gap) * step;
      unit.y = heightAt(this.world, unit.x, unit.z) + (unit.type === "artillery" ? 0.7 : 0.95);
    }
  }

  pickTarget(unit: Unit, binding: Binding, rangeM: number) {
    const foes = this.living(other(unit.side));
    const scored = foes
      .filter((foe) => Math.hypot(foe.x - unit.x, foe.z - unit.z) <= rangeM && hasLos(this.world, unit.x, unit.z, foe.x, foe.z))
      .map((foe) => {
        const dist = Math.hypot(foe.x - unit.x, foe.z - unit.z);
        const bonus = binding.order.priority === foe.type ? -40 : 0;
        return { foe, score: dist + bonus };
      })
      .sort((a, b) => a.score - b.score);
    return scored[0]?.foe;
  }

  fireTick(dt: number) {
    for (const unit of this.living()) {
      unit.reload = Math.max(0, unit.reload - dt);
      if (!unit.bindingId) continue;
      const binding = this.bindings.get(unit.bindingId);
      if (!binding || binding.order.kind === "reserve" || binding.order.holdFire) continue;
      const limbered = unit.type === "artillery" && (binding.order.kind === "move" || binding.order.kind === "retreat" || binding.order.kind === "charge");
      if (limbered) continue;
      if (unit.reload > 0) continue;
      if (unit.type === "artillery") {
        // Only a deliberate bombardment shells a map cell. A battery standing on
        // its ground engages what it can see, exactly like the infantry --
        // treating "hold" as a bombard order pointed a battery at the rally
        // cell it was formed on and dropped the first round on its own crew.
        const shelling = binding.order.kind === "bombard" || binding.order.kind === "attack_area";
        const aim = shelling && binding.order.cells[0] ? cellCenter(binding.order.cells[0]) : undefined;
        if (aim) this.fireArtillery(unit, binding, aim.x, aim.z);
        else {
          const target = this.pickTarget(unit, binding, Math.min(binding.order.engageRange * 2.2, ARTILLERY_RANGE));
          if (target) this.fireArtillery(unit, binding, target.x, target.z);
        }
        continue;
      }
      if (unit.type === "infantry" || unit.type === "cavalry") {
        const target = this.pickTarget(unit, binding, binding.order.engageRange);
        if (!target) continue;
        this.spawnShot(unit, target.x, target.y + 0.4, target.z, "musket", musketCone(unit.weapon, unit.powder), 0);
        this.report("musket", unit.x, unit.z);
        unit.reload = musketReload(unit.weapon, unit.powder);
      }
    }
  }

  /** Log a shot for the view to hear and flash. Bounded: an unread backlog dies. */
  private report(kind: Report["kind"], x: number, z: number) {
    this.reports.push({ kind, x, z });
    if (this.reports.length > 96) this.reports.splice(0, this.reports.length - 96);
  }

  takeReports(): Report[] {
    const out = this.reports;
    this.reports = [];
    return out;
  }

  fireArtillery(unit: Unit, binding: Binding, ax: number, az: number) {
    // No gunner lays a piece on his own limber. Anything inside the minimum
    // range is refused outright rather than clamped, so a battery ordered to
    // shell the ground under itself simply holds its fire.
    if (Math.hypot(ax - unit.x, az - unit.z) < ARTILLERY_MIN_RANGE) return;
    const ay = heightAt(this.world, ax, az) + 0.8;
    if (binding.order.load === "canister") {
      for (let i = 0; i < 11; i += 1) this.spawnShot(unit, ax, ay, az, "canister", 0.18, 0);
      this.report("canister", unit.x, unit.z);
    } else {
      this.spawnShot(unit, ax, ay, az, "ball", 0.03, artilleryBlast(unit.calibre));
      this.report("ball", unit.x, unit.z);
    }
    unit.reload = artilleryReload(unit.calibre);
  }

  /**
   * Put a round in the air.
   *
   * Muskets shoot flat; artillery does not. Laying a ball straight at the
   * target with a flat trajectory drops it twenty metres in front of the
   * muzzle, which makes a battery both useless and — with a blast radius —
   * suicidal. So round shot and canister solve for the elevation that
   * actually reaches the mark, taking the low arc a gunner would use.
   */
  spawnShot(from: Unit, tx: number, ty: number, tz: number, kind: Projectile["kind"], cone: number, blast: number) {
    const dx = tx - from.x;
    const dz = tz - from.z;
    const flat = Math.hypot(dx, dz) || 1;
    const speed = kind === "musket" ? 118 : kind === "canister" ? 90 : 72;
    const range = kind === "musket" ? musketRange(from.powder) : ARTILLERY_RANGE;
    const muzzleY = from.y + 0.4;
    const rise = ty - muzzleY;
    const yaw = (Math.random() - 0.5) * cone;

    let pitch: number;
    if (kind === "musket") {
      pitch = Math.atan2(rise, flat) + (Math.random() - 0.5) * cone * 0.45;
    } else {
      // v^4 - g(g d^2 + 2 h v^2) under the root; negative means the mark is
      // out of reach, and the gunner lays at maximum range instead.
      const v2 = speed * speed;
      const root = v2 * v2 - GRAVITY * (GRAVITY * flat * flat + 2 * rise * v2);
      pitch = root < 0
        ? Math.PI / 4
        : Math.atan((v2 - Math.sqrt(root)) / (GRAVITY * flat));
      pitch += (Math.random() - 0.5) * cone * 0.45;
    }

    const bearing = Math.atan2(dx, dz) + yaw;
    const level = Math.cos(pitch) * speed;
    this.projectiles.push({
      id: this.id("p"),
      kind,
      side: from.side,
      from: from.id,
      age: 0,
      x: from.x + Math.sin(bearing) * 1.4,
      y: muzzleY,
      z: from.z + Math.cos(bearing) * 1.4,
      vx: Math.sin(bearing) * level,
      vy: Math.sin(pitch) * speed,
      vz: Math.cos(bearing) * level,
      life: Math.min(14, range / speed + (kind === "musket" ? 0 : 3)),
      blast,
    });
  }


  stepProjectiles(dt: number) {
    const keep: Projectile[] = [];
    for (const shot of this.projectiles) {
      const steps = 3;
      let dead = false;
      for (let i = 0; i < steps && !dead; i += 1) {
        const h = dt / steps;
        shot.x += shot.vx * h;
        shot.y += shot.vy * h - GRAVITY * h * h * 0.5;
        shot.vy -= GRAVITY * h;
        shot.z += shot.vz * h;
        shot.life -= h;
        shot.age += h;
        const cell = cellOf(shot.x, shot.z);
        if (blocksShot(terrainAt(this.world, cell.x, cell.y)) && shot.y < heightAt(this.world, shot.x, shot.z) + 4.5) {
          dead = true;
          break;
        }
        if (shot.y < heightAt(this.world, shot.x, shot.z) + 0.15) {
          if (shot.blast > 0) {
            this.blast(shot.x, shot.z, shot.blast, shot.from);
            this.shellStructure(shot.x, shot.z, shot.blast);
          }
          dead = true;
          break;
        }
        for (const unit of this.living()) {
          // A round leaves the muzzle less than a metre from the crew, and a
          // piece is a metre wide, so without both of these guards a battery
          // detonates its own shell on itself the instant it opens fire.
          if (unit.id === shot.from) continue;
          if (shot.age < 0.12) break;
          if (shot.kind === "musket" && unit.side === shot.side) continue;
          const rad = unit.type === "artillery" ? 1.1 : 0.45;
          if (Math.hypot(unit.x - shot.x, unit.z - shot.z) < rad && Math.abs(unit.y - shot.y) < 1.6) {
            if (shot.blast > 0) {
              this.blast(shot.x, shot.z, shot.blast, shot.from);
              this.shellStructure(shot.x, shot.z, shot.blast);
            } else this.kill(unit);
            dead = true;
            break;
          }
        }
      }
      if (!dead && shot.life > 0) keep.push(shot);
    }
    this.projectiles = keep;
  }

  /**
   * A ball kills the file it strikes, not the battalion.
   *
   * Flat lethality across the whole radius made one round shot erase a
   * formation outright, which made every other arm pointless and turned any
   * advance into suicide. Lethality now falls away sharply from the point of
   * impact, so a well-served battery bleeds a column instead of deleting it.
   */
  /**
   * Where a round shot lands.
   *
   * It ploughs a lane through the ranks; it does not annihilate a disc. Rolling
   * the odds against every man inside the blast did exactly that -- a single
   * ball on a close-packed battalion took fifty men, so four guns wiped a
   * hundred-and-fourteen-man column off the field in a minute without losing a
   * gunner. The shot is capped at what a ball can actually do to a file, and
   * takes the nearest men first.
   */
  blast(x: number, z: number, radius: number, from?: string) {
    const caught = this.living()
      .filter((unit) => unit.id !== from && Math.hypot(unit.x - x, unit.z - z) <= radius)
      .map((unit) => ({ unit, gap: Math.hypot(unit.x - x, unit.z - z) }))
      .sort((a, b) => a.gap - b.gap);
    let down = 0;
    for (const { unit, gap } of caught) {
      if (down >= BALL_FILE) break;
      if (Math.random() >= (1 - gap / radius) ** 1.8) continue;
      this.kill(unit);
      down += 1;
    }
  }

  /**
   * The shock of a charge.
   *
   * A charge used to be a lawnmower: every trooper cut down every enemy within
   * reach, on every one of the twenty ticks a second, for nothing. Ten horsemen
   * riding through a column erased it and rode out untouched, which is how a
   * hundred and fourteen men could be lost to sixty without the enemy losing
   * one. A charge now costs what a charge costs -- one man ridden down, then
   * the trooper has to get clear and come round again, and formed infantry
   * takes some of them with it.
   */
  meleeTick() {
    const bodies = this.living();
    for (const unit of bodies) {
      if (unit.type === "artillery" || unit.reload > 0) continue;
      const binding = unit.bindingId ? this.bindings.get(unit.bindingId) : undefined;
      if (binding?.order.kind !== "charge") continue;
      const need = unit.type === "cavalry" ? LANCE_SPEED : BAYONET_SPEED;
      if (unit.speed < need) continue;
      for (const foe of bodies) {
        if (foe.side === unit.side || !foe.alive) continue;
        if (Math.hypot(foe.x - unit.x, foe.z - unit.z) > MELEE_RANGE) continue;
        this.kill(foe);
        this.melee += 1;
        unit.reload = MELEE_RECOVER_S;
        if (foe.type !== "artillery" && Math.random() < MELEE_ANSWER) this.kill(unit);
        break;
      }
    }
  }

  kill(unit: Unit) {
    if (!unit.alive) return;
    unit.alive = false;
    unit.speed = 0;
  }

  /** Depots held, which is the tiebreak when the clock runs out. */
  held(side: Side) {
    return this.structuresOf(side).filter((structure) => structure.kind === "depot").length;
  }

  evaluateResult() {
    if (this.result) return;
    if (!this.mainOf("player")) return this.finish("lose");
    if (!this.mainOf("enemy")) return this.finish("win");
    if (this.clock < this.settings.timeLimitS) return;
    const mine = this.held("player");
    const theirs = this.held("enemy");
    if (mine > theirs) return this.finish("win");
    if (theirs > mine) return this.finish("lose");
    return this.finish("draw");
  }

  finish(result: ResultKind) {
    this.result = result;
    this.phase = "result";
  }
}

export type OrderPatch = {
  order?: OrderKind;
  cells?: Cell[];
  holdFire?: boolean;
  fireAtWill?: boolean;
  engageRange?: number;
  priority?: Priority;
  load?: Load;
  shape?: Shape;
  spacing?: number;
  facing?: number;
  faceCell?: Cell;
  sequence?: SequenceStep[];
};

export type { Rule };