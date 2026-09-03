import { WORKS, WORK_REACH_TILES } from "./constants";
import { cellOf } from "./terrain";
import type { Match } from "./match";
import type { Binding, Cell, Structure, UnitType } from "./types";

/**
 * The opposing staff.
 *
 * It plays the same game the player does — the same crates, the same supply
 * rules, the same standing-orders book — and it is deliberately written as
 * three separate jobs rather than one scoring function, because an opponent
 * that visibly *does things* (raises men, pushes a redoubt forward, sends a
 * squadron round the flank to cut a line) teaches the systems far better than
 * one that plays optimally and illegibly.
 */

const gap = (a: Cell, b: Cell) => Math.hypot(a.x - b.x, a.y - b.y);

const spendable = (match: Match) => match.supply.enemy;

/**
 * How large an army the opposing staff will keep in the field.
 *
 * Easy is not a slower version of Hard: on the lowest setting the enemy stops
 * raising once it has a fair field force, so a player who is still learning
 * where the depots are has an army to learn with rather than a hundred and
 * forty men at the gate by the sixth minute.
 */
const ARMY_CAP = [0, 90, 150, 260] as const;

/** Raise men wherever it can, weighted to what it is short of. */
const raise = (match: Match) => {
  const bases = match.structuresOf("enemy").filter((s) => s.connected && s.build >= 1 && s.kind !== "depot");
  if (!bases.length) return;
  const cap = ARMY_CAP[match.settings.difficulty] ?? 150;
  if (match.living("enemy").length >= cap) return;
  const mix = tally(match);
  const want: UnitType = mix.infantry < 40 ? "infantry" : mix.artillery < 2 ? "artillery" : mix.cavalry < 18 ? "cavalry" : "infantry";
  const count = want === "artillery" ? 1 : want === "cavalry" ? 8 : 16;
  const base = bases[match.production.filter((o) => o.side === "enemy").length % bases.length];
  if (!base) return;
  match.recruit("enemy", base.id, want, count, match.settings.difficulty >= 3 ? 3 : 2);
};

const tally = (match: Match) => {
  const out = { infantry: 0, cavalry: 0, artillery: 0 };
  for (const unit of match.living("enemy")) out[unit.type] += 1;
  return out;
};

/** Push the network toward the nearest depot it does not hold. */
const extend = (match: Match) => {
  // An easy opponent banks before it builds, so its network creeps forward
  // instead of reaching every depot on the field inside four minutes.
  const thrift = match.settings.difficulty === 1 ? 3.4 : 1.6;
  if (spendable(match) < WORKS.fort.cost * thrift) return;
  const mine = match.structuresOf("enemy").filter((s) => s.connected);
  const prizes = [...match.structures.values()].filter((s) => s.kind === "depot" && s.side !== "enemy");
  if (!mine.length || !prizes.length) return;
  let best: { at: Cell; score: number } | null = null;
  for (const prize of prizes) {
    for (const anchor of mine) {
      const reach = gap(anchor.cell, prize.cell);
      const step = Math.min(1, (WORK_REACH_TILES - 2) / Math.max(1, reach));
      const at = {
        x: Math.round(anchor.cell.x + (prize.cell.x - anchor.cell.x) * step),
        y: Math.round(anchor.cell.y + (prize.cell.y - anchor.cell.y) * step),
      };
      const score = gap(at, prize.cell);
      if (!best || score < best.score) best = { at, score };
    }
  }
  if (best) match.build("enemy", "fort", best.at);
};

/**
 * Formations that want a new job.
 *
 * A staff that re-tasks every battalion every four seconds is not a staff —
 * it is a formation stuck at a crossroads, because each new order points
 * somewhere else and the column nets no ground. So a formation keeps its job
 * until it has arrived, lost its objective, or has nothing to do. Batteries are
 * the exception: they do not march, and re-laying onto a nearer target is
 * exactly what a battery should do.
 */
const needsOrders = (match: Match, binding: Match["bindings"] extends Map<string, infer B> ? B : never) => {
  const members = match.bindingUnits(binding);
  if (!members.length) return false;
  if (members[0]?.type === "artillery") return true;
  const kind = binding.order.kind;
  if (kind === "hold" || kind === "reserve") return true;
  const goal = binding.order.cells[0];
  if (!goal) return true;
  const here = match.bindingCell(binding);
  if (Math.max(Math.abs(goal.x - here.x), Math.abs(goal.y - here.y)) <= 1) return true;
  // A column that has been marching at the same objective for a minute is not
  // marching, it is stuck behind something. Give it something else to do.
  return match.clock - binding.order.setAt > 60;
};

const idleFormations = (match: Match) =>
  [...match.bindings.values()].filter((binding) =>
    binding.side === "enemy" && needsOrders(match, binding));

/**
 * The nearest enemy column, and how far off it is.
 *
 * The staff had no notion of an army in front of it: it only ever reacted to
 * one of its own works being hurt. On a small field that hardly showed,
 * because everything was within a few hundred metres of everything else. On
 * these fields it meant the two armies walked past each other to opposite
 * corners and the battle never happened.
 */
const nearestColumn = (match: Match, here: Cell, reach: number) => {
  let best: { cell: Cell; gap: number } | null = null;
  for (const binding of match.bindings.values()) {
    if (binding.side !== "player") continue;
    if (!match.bindingUnits(binding).length) continue;
    const cell = match.bindingCell(binding);
    const off = gap(cell, here);
    if (off > reach || (best && off >= best.gap)) continue;
    best = { cell, gap: off };
  }
  return best;
};

/** Give every formation a job: take a depot, screen a line, or press the attack. */
const assign = (match: Match) => {
  const formations = idleFormations(match);
  if (!formations.length) return;
  const playerMain = match.mainOf("player");
  const prizes = [...match.structures.values()].filter((s) => s.kind === "depot" && s.side !== "enemy");
  const threatened = match.structuresOf("enemy").filter((s) => !s.connected || s.hp < s.maxHp * 0.8);
  const pressure = match.settings.difficulty;

  const claimed = new Set<string>();
  for (const binding of formations) {
    const here = match.bindingCell(binding);
    const members = match.bindingUnits(binding);
    const kind = members[0]?.type ?? "infantry";

    if (kind === "artillery") {
      const aim = nearestFoeCell(match, here) ?? playerMain?.cell;
      if (aim) match.issue(binding.name, { order: "bombard", cells: [aim], load: "round" }, "enemy");
      continue;
    }

    const rescue = threatened
      .filter((s) => !claimed.has(s.id))
      .sort((a, b) => gap(a.cell, here) - gap(b.cell, here))[0];
    if (rescue && gap(rescue.cell, here) < 22) {
      claimed.add(rescue.id);
      match.issue(binding.name, { order: "attack_area", cells: [rescue.cell] }, "enemy");
      continue;
    }

    // A column marching through your ground beats a depot two hundred metres
    // away. Harder settings look further out for one.
    const column = nearestColumn(match, here, 14 + pressure * 7);
    const prize = prizes
      .filter((s) => !claimed.has(s.id))
      .sort((a, b) => gap(a.cell, here) - gap(b.cell, here))[0];
    if (column && (!prize || column.gap < gap(prize.cell, here))) {
      match.issue(
        binding.name,
        { order: kind === "cavalry" ? "charge" : "attack_area", cells: [column.cell] },
        "enemy",
      );
      continue;
    }
    if (prize) {
      claimed.add(prize.id);
      match.issue(binding.name, { order: kind === "cavalry" ? "move" : "attack_area", cells: [prize.cell] }, "enemy");
      continue;
    }

    // Everything is held: raid the supply line, or go for the throat.
    const target = pressure >= 2 && playerMain
      ? raidCell(match, playerMain, binding)
      : playerMain?.cell;
    if (target) {
      match.issue(binding.name, { order: kind === "cavalry" ? "charge" : "attack_area", cells: [target] }, "enemy");
    }
  }
};

/** A cell on the player's supply network worth sitting on. */
const raidCell = (match: Match, playerMain: Structure, binding: Binding): Cell => {
  const here = match.bindingCell(binding);
  const routes = match.structuresOf("player")
    .filter((s) => s.connected && s.route.length > 4)
    .flatMap((s) => s.route.slice(2, -2));
  if (!routes.length) return playerMain.cell;
  return routes.sort((a, b) => gap(a, here) - gap(b, here))[0] ?? playerMain.cell;
};

const nearestFoeCell = (match: Match, from: Cell): Cell | null => {
  let best: { cell: Cell; d: number } | null = null;
  for (const unit of match.living("player")) {
    if (!match.visibleTo("enemy", unit).seen) continue;
    const cell = cellOf(unit.x, unit.z);
    const d = gap(cell, from);
    if (!best || d < best.d) best = { cell, d };
  }
  return best?.cell ?? null;
};

export const botThink = (match: Match) => {
  if (match.phase !== "battle" || match.result) return;
  raise(match);
  extend(match);
  assign(match);
};
