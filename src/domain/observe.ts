import { FOB_COST, FOB_REACH_TILES, TILE_M } from "./constants";
import { describeRule } from "./rules";
import { cellOf, terrainAt } from "./terrain";
import { unitCost } from "./match";
import type { Match } from "./match";
import type { Cell, CommandResult, RuleTarget, Side } from "./types";

const terrainGlyph: Record<string, string> = {
  open: ".",
  road: "=",
  rough: "r",
  woods: "T",
  building: "#",
  water: "~",
};

const countTypes = (types: string[]) =>
  types.reduce<Record<string, number>>((acc, type) => {
    acc[type] = (acc[type] ?? 0) + 1;
    return acc;
  }, {});

/** How the rule book names a clause, for both the panel and the tool output. */
export const targetLabel = (match: Match, target: RuleTarget) => {
  switch (target.kind) {
    case "binding":
      return target.ref ?? "a formation";
    case "structure":
      return match.structures.get(target.ref ?? "")?.name ?? "a base";
    case "self":
      return "it";
    case "any_binding":
      return "any formation";
    case "any_structure":
      return "any base";
    case "nearest_reserve":
      return "the nearest reserve";
    default:
      return "someone";
  }
};

export const overview = (match: Match, side: Side = "player") => {
  const bindings = [...match.bindings.values()]
    .filter((binding) => binding.side === side)
    .map((binding) => {
      const members = match.bindingUnits(binding);
      return {
        name: binding.name,
        count: members.length,
        establishment: binding.establishment,
        types: countTypes(members.map((unit) => unit.type)),
        cell: match.bindingCell(binding),
        shape: binding.shape,
        spacing: binding.spacing,
        facing: Number(binding.facing.toFixed(2)),
        order: binding.order.kind,
        target: binding.order.cells,
        holdFire: binding.order.holdFire,
        engageRange: binding.order.engageRange,
        priority: binding.order.priority,
        load: binding.order.load,
      };
    });

  const structures = [...match.structures.values()]
    .filter((structure) => structure.side === side || structure.side === "neutral" || nearbyKnown(match, side, structure.cell))
    .map((structure) => ({
      id: structure.id,
      name: structure.name,
      kind: structure.kind,
      side: structure.side,
      cell: structure.cell,
      hp: Math.round(structure.hp),
      maxHp: structure.maxHp,
      build: Number(structure.build.toFixed(2)),
      connected: structure.connected,
      yieldPerMin: structure.yield,
      capture: Number(structure.capture.toFixed(2)),
      capturingSide: structure.capturingSide,
      routeTiles: structure.route.length,
      rally: structure.rally,
    }));

  return {
    phase: match.phase,
    clockS: Math.floor(match.clock),
    remainingS: Math.max(0, Math.floor(match.settings.timeLimitS - match.clock)),
    result: match.result,
    supply: Math.floor(match.supply[side]),
    incomePerMin: match.income[side],
    depotsHeld: match.held(side),
    prices: {
      fob: FOB_COST,
      fobReachTiles: FOB_REACH_TILES,
      infantry: unitCost("infantry", 2),
      cavalry: unitCost("cavalry", 2),
      artillery: unitCost("artillery", 2),
    },
    map: { id: match.world.id, name: match.world.name, width: match.world.width, height: match.world.height, tileM: TILE_M },
    bindings,
    structures,
    production: match.production
      .filter((order) => order.side === side)
      .map((order) => ({ id: order.id, at: match.structures.get(order.structureId)?.name ?? "?", type: order.type, count: order.count, leftS: Math.ceil(order.leftS) })),
    contacts: match.contacts(side),
    rules: match.rules.filter((rule) => rule.side === side).map((rule) => ({
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      reads: describeRule(rule, (target) => targetLabel(match, target)),
      fired: rule.fired,
      cooldownLeft: Math.ceil(rule.cooldownLeft),
    })),
    alerts: match.alerts.filter((alert) => alert.side === side).slice(0, 12),
    ascii: asciiMap(match, side),
    next: "read_alerts to see what the field reported, add_rule to answer it without being asked again.",
  };
};

const nearbyKnown = (match: Match, side: Side, cell: Cell) =>
  match.contacts(side).some((contact) => Math.hypot(contact.cell.x - cell.x, contact.cell.y - cell.y) <= 3);

export const inspectBinding = (match: Match, name: string, side: Side = "player"): CommandResult => {
  const binding = match.bindingByName(name);
  if (!binding || binding.side !== side) {
    return { ok: false, error: { code: "binding_not_found", message: `No friendly binding named ${name}.` } };
  }
  const members = match.bindingUnits(binding);
  return {
    ok: true,
    data: {
      name: binding.name,
      side: binding.side,
      shape: binding.shape,
      spacing: binding.spacing,
      facing: Number(binding.facing.toFixed(2)),
      order: binding.order,
      establishment: binding.establishment,
      cell: match.bindingCell(binding),
      members: members.map((unit) => ({
        id: unit.id,
        type: unit.type,
        grade: unit.weapon,
        cell: cellOf(unit.x, unit.z),
      })),
    },
  };
};

export const inspectStructure = (match: Match, id: string, side: Side = "player"): CommandResult => {
  const structure = match.structures.get(id);
  if (!structure) return { ok: false, error: { code: "structure_not_found", message: "No base or depot with that id." } };
  return {
    ok: true,
    data: {
      ...structure,
      hp: Math.round(structure.hp),
      mine: structure.side === side,
      route: structure.route,
    },
  };
};

export const inspectCell = (match: Match, cell: Cell, side: Side = "player") => {
  const terrain = terrainAt(match.world, cell.x, cell.y);
  const here = match.living().filter((unit) => {
    const at = cellOf(unit.x, unit.z);
    return at.x === cell.x && at.y === cell.y;
  });
  const control = match.controlField(side);
  const interdicted = Boolean(control?.blocked[cell.y * match.world.width + cell.x]);
  const friends = here.filter((unit) => unit.side === side).map((unit) => ({ id: unit.id, type: unit.type, binding: unit.bindingId }));
  const foes = here.filter((unit) => unit.side !== side).flatMap((unit) => {
    const sight = match.visibleTo(side, unit);
    if (!sight.seen) return [];
    return [{ band: sight.band, type: sight.band === "unknown" ? undefined : unit.type }];
  });
  const structure = [...match.structures.values()].find((item) =>
    cell.x >= item.cell.x && cell.x < item.cell.x + item.span &&
    cell.y >= item.cell.y && cell.y < item.cell.y + item.span);
  return { ok: true as const, data: { cell, terrain, interdicted, friends, foes, structure: structure ? { id: structure.id, name: structure.name, side: structure.side } : null } };
};

export const inspectContact = (match: Match, contactId: string, side: Side = "player") => {
  const contact = match.contacts(side).find((item) => item.id === contactId);
  if (!contact) return { ok: false as const, error: { code: "contact_not_found", message: "That contact is gone or not visible." } };
  return { ok: true as const, data: contact };
};

export const readAlerts = (match: Match, side: Side = "player", limit = 20) => ({
  ok: true as const,
  data: {
    clockS: Math.floor(match.clock),
    alerts: match.alerts.filter((alert) => alert.side === side).slice(0, Math.max(1, Math.min(60, limit))),
    unanswered: match.alerts.filter((alert) => alert.side === side && !alert.ruleId).length,
  },
});

/**
 * The map as text.
 *
 * Bases and depots take precedence over bodies, because an agent reading this
 * is nearly always deciding where to go rather than what to shoot.
 */
const asciiMap = (match: Match, side: Side) => {
  const { width, height } = match.world;
  const grid = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => terrainGlyph[terrainAt(match.world, x, y)] ?? "."),
  );
  const put = (cell: Cell, glyph: string) => {
    const row = grid[cell.y];
    if (row && row[cell.x] !== undefined) row[cell.x] = glyph;
  };
  for (const unit of match.living()) {
    const cell = cellOf(unit.x, unit.z);
    if (unit.side === side) {
      put(cell, unit.type === "cavalry" ? "c" : unit.type === "artillery" ? "g" : "i");
      continue;
    }
    const sight = match.visibleTo(side, unit);
    if (!sight.seen) continue;
    put(cell, sight.band === "unknown" ? "?" : unit.type === "cavalry" ? "C" : unit.type === "artillery" ? "G" : "I");
  }
  for (const structure of match.structures.values()) {
    const mine = structure.side === side;
    const glyph = structure.kind === "main" ? (mine ? "H" : "X") : structure.kind === "fob" ? (mine ? "f" : "F") : structure.side === "neutral" ? "o" : mine ? "d" : "D";
    for (let dy = 0; dy < structure.span; dy += 1) {
      for (let dx = 0; dx < structure.span; dx += 1) put({ x: structure.cell.x + dx, y: structure.cell.y + dy }, glyph);
    }
  }
  const legend = "H your HQ  X enemy HQ  f/F redoubt  o free depot  d/D depot  i/c/g yours  I/C/G theirs  ? unidentified";
  return `${grid.map((row) => row.join("")).join("\n")}\n${legend}`;
};
