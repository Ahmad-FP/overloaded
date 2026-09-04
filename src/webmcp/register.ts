import {
  addRule, bindUnits, buildWork, inspectBinding, inspectCell, inspectContact, inspectStructure,
  issue, overview, readAlerts, recruit, removeRule, renameBinding, startBattle, unbind, updateRule,
} from "../domain/commands";
import { WORK_KINDS, WORKS,
  ACTIONS, LOADS, MAP_IDS, ORDERS, PRIORITIES, SHAPES, TRIGGERS, UNIT_TYPES,
} from "../domain/constants";
import { FIELD_SIZES } from "../domain/maps";
import type { Match } from "../domain/match";
import {
  ACTION_ORDER, ACTIONS_FOR, describeRule, HAS_ATTACKER, NEEDS_PLACE, TRIGGER_TEXT, TRIGGERS_FOR,
} from "../domain/rules";
import { naming } from "../domain/observe";
import type {
  Cell, Load, MapId, OrderActor, OrderKind, OrderPlace, Priority, Quality, Rule, Shape, Watched,
} from "../domain/types";

type UnknownRecord = Record<string, unknown>;

/**
 * Every tool answers in WebMCP's content envelope.
 *
 * The registration callback is typed `MaybePromise<unknown>`, so handing back a
 * bare JSON string type-checks happily -- but the spec's own sample returns
 * `{ content: [{ type: "text", text }] }`, and that is what a caller unpacks.
 * The payload stays JSON so an agent gets structured data rather than prose.
 */
const json = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
const fail = (code: string, message: string, details?: unknown) =>
  json({ ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } });
const isRecord = (value: unknown): value is UnknownRecord =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown, max = 48) =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown) => typeof value === "boolean" ? value : undefined;
const int = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const quality = (value: unknown): Quality | undefined =>
  value === 1 || value === 2 || value === 3 ? value : undefined;
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (list as readonly string[]).includes(value) ? value as T : undefined;
const cell = (value: unknown): Cell | undefined => {
  if (!isRecord(value)) return undefined;
  if (!int(value.x, 0, 200) || !int(value.y, 0, 200)) return undefined;
  return { x: value.x as number, y: value.y as number };
};
const cells = (value: unknown): Cell[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(cell);
  if (parsed.some((item) => !item)) return undefined;
  return parsed as Cell[];
};

/**
 * A watch, an actor or a place, from either the object form or a bare name.
 *
 * A bare string is checked against the live structure ids first, so `"base1"`
 * names a base and `"Alpha"` names a formation without the caller having to
 * say which. Nothing here accepts a wildcard: every order names one thing.
 */
const watched = (match: Match, value: unknown): Watched | undefined => {
  if (value === "chest") return { kind: "chest" };
  if (typeof value === "string") {
    return match.structures.has(value)
      ? { kind: "structure", ref: value }
      : { kind: "binding", ref: value };
  }
  if (!isRecord(value)) return undefined;
  if (value.kind === "chest") return { kind: "chest" };
  const ref = text(value.ref, 40);
  if (!ref) return undefined;
  if (value.kind === "binding" || value.kind === "structure") return { kind: value.kind, ref };
  return undefined;
};

const actorOf = (match: Match, value: unknown): OrderActor | undefined => {
  const parsed = watched(match, value);
  return parsed && parsed.kind !== "chest" ? parsed : undefined;
};

const placeOf = (match: Match, value: unknown): OrderPlace | null | undefined => {
  if (value === null) return null;
  if (value === "attacker") return { kind: "attacker" };
  if (typeof value === "string") {
    return match.structures.has(value)
      ? { kind: "structure", ref: value }
      : { kind: "binding", ref: value };
  }
  const at = cell(value);
  return at ? { kind: "point", cell: at } : undefined;
};

const rulePatch = (match: Match, input: UnknownRecord): Partial<Rule> => {
  const patch: Partial<Rule> = {};
  const enabled = bool(input.enabled);
  if (enabled !== undefined) patch.enabled = enabled;
  if (input.watch !== undefined) {
    const parsed = watched(match, input.watch);
    if (parsed) patch.watch = parsed;
  }
  if (input.actor !== undefined) {
    const parsed = actorOf(match, input.actor);
    if (parsed) patch.actor = parsed;
  }
  if (input.place !== undefined) {
    const parsed = placeOf(match, input.place);
    if (parsed !== undefined) patch.place = parsed;
  }
  const trigger = oneOf(TRIGGERS, input.trigger);
  if (trigger) patch.trigger = trigger;
  const action = oneOf(ACTIONS, input.action);
  if (action) patch.action = action;
  const threshold = num(input.threshold);
  if (threshold !== undefined) patch.threshold = threshold;
  const unitType = oneOf(UNIT_TYPES, input.unitType);
  if (unitType) patch.unitType = unitType;
  const count = num(input.count);
  if (count !== undefined) patch.count = Math.round(count);
  const once = bool(input.once);
  if (once !== undefined) patch.once = once;
  const cooldownS = num(input.cooldownS);
  if (cooldownS !== undefined) patch.cooldownS = cooldownS;
  return patch;
};

const tool = (
  name: string,
  title: string,
  description: string,
  inputSchema: object,
  execute: WebMCP.ToolExecuteCallback,
  annotations: WebMCP.ToolAnnotations,
): WebMCP.ModelContextTool => ({ name, title, description, inputSchema, execute, annotations });

const wrap = <T>(result: { ok: true; data: T } | { ok: false; error: { code: string; message: string; details?: unknown } }) =>
  result.ok ? json({ ok: true, data: result.data }) : fail(result.error.code, result.error.message, result.error.details);

const empty = { type: "object", additionalProperties: false, properties: {} };

const WATCH_SCHEMA = {
  description: "What the order is written against, and it must be one named thing: a formation name like \"Alpha\", "
    + "a structure id like \"base1\", or \"chest\" for your own war chest. There is no wildcard.",
  anyOf: [
    { type: "string" },
    {
      type: "object", additionalProperties: false, required: ["kind"],
      properties: { kind: { enum: ["binding", "structure", "chest"] }, ref: { type: "string" } },
    },
  ],
};

const ACTOR_SCHEMA = {
  description: "Who carries the order out: a formation name like \"Alpha\", or a structure id like \"base1\" "
    + "(a base can only raise men).",
  anyOf: [
    { type: "string" },
    {
      type: "object", additionalProperties: false, required: ["kind", "ref"],
      properties: { kind: { enum: ["binding", "structure"] }, ref: { type: "string" } },
    },
  ],
};

const PLACE_SCHEMA = {
  description: "The ground the order aims at, always named: \"attacker\" for the enemy that set the watch off "
    + "(only for under_fire, spotted and threatened), a formation name, a structure id, or { x, y } for a "
    + "marked spot. Orders that go nowhere -- fall back, stand in reserve, raise men -- take no place.",
  anyOf: [
    { type: "string" },
    {
      type: "object", additionalProperties: false, required: ["x", "y"],
      properties: { x: { type: "integer" }, y: { type: "integer" } },
    },
  ],
};

const CELLS_SCHEMA = {
  type: "array",
  maxItems: 8,
  items: {
    type: "object", additionalProperties: false, required: ["x", "y"],
    properties: { x: { type: "integer" }, y: { type: "integer" } },
  },
};

export const createTools = (match: Match): WebMCP.ModelContextTool[] => [
  tool("overview", "Read the field",
    "The whole readable state in one call: crates and income, depots held, every friendly formation and work, "
    + "production in hand, visible enemy contacts, the standing-order book, recent dispatches, and an ASCII map. "
    + "Call this first. Enemy equipment is never shown — only what your side can see.",
    empty,
    (input) => {
      if (Object.keys(input).length) return fail("invalid_input", "overview takes no parameters.");
      return json({ ok: true, data: overview(match) });
    }, { readOnlyHint: true }),

  tool("inspect_binding", "Inspect a formation",
    "One friendly formation's strength, order, engagement settings and position.",
    { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" } } },
    (input) => {
      const name = text(input.name);
      if (!name) return fail("invalid_input", "name is required.");
      return wrap(inspectBinding(match, name));
    }, { readOnlyHint: true }),

  tool("inspect_structure", "Inspect a base",
    "One base, forward work or depot: health, build progress, yield, and whether its supply route home is open.",
    { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
    (input) => {
      const id = text(input.id, 24);
      if (!id) return fail("invalid_input", "id is required.");
      return wrap(inspectStructure(match, id));
    }, { readOnlyHint: true }),

  tool("inspect_cell", "Inspect a cell",
    "Terrain, height, ownership, whether the cell is interdicted by the enemy, and who is visible there.",
    {
      type: "object", additionalProperties: false, required: ["x", "y"],
      properties: { x: { type: "integer" }, y: { type: "integer" } },
    },
    (input) => {
      const at = cell(input);
      if (!at) return fail("invalid_input", "x and y must be integers on the map.");
      return wrap(inspectCell(match, at));
    }, { readOnlyHint: true }),

  tool("inspect_contact", "Inspect a contact",
    "What is known about one visible enemy contact. Distance decides how much that is.",
    { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
    (input) => {
      const id = text(input.id, 24);
      if (!id) return fail("invalid_input", "id is required.");
      return wrap(inspectContact(match, id));
    }, { readOnlyHint: true }),

  tool("read_alerts", "Read dispatches",
    "The dispatch feed, newest first: what happened, to whom, and which standing order answered it.",
    {
      type: "object", additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 60 } },
    },
    (input) => wrap(readAlerts(match, "player", num(input.limit) ?? 20)),
    { readOnlyHint: true }),

  tool("list_rules", "Read the order book",
    "Every standing order you hold, as the English sentence it reads on screen, plus how many times it has acted.",
    empty,
    (input) => {
      if (Object.keys(input).length) return fail("invalid_input", "list_rules takes no parameters.");
      const name = naming(match);
      return json({
        ok: true,
        data: {
          vocabulary: {
            triggers: TRIGGERS.map((trigger) => ({ trigger, reads: TRIGGER_TEXT[trigger] })),
            actions: ACTIONS.map((action) => ({
              action, reads: ACTION_ORDER[action], needsPlace: NEEDS_PLACE(action),
            })),
            watchable: "one named formation, one structure id, or \"chest\"",
            places: "\"attacker\", a formation name, a structure id, or { x, y }",
            attackerOnlyAfter: TRIGGERS.filter(HAS_ATTACKER),
          },
          // What each of your things can actually be told to do, and what it
          // can report. The panel filters its dropdowns with exactly this, so
          // an order built from it cannot be one that could never fire.
          canOrder: [
            ...[...match.bindings.values()]
              .filter((binding) => binding.side === "player" && match.bindingUnits(binding).length > 0)
              .map((binding) => {
                const arm = match.bindingUnits(binding)[0]?.type ?? null;
                return {
                  actor: binding.name, kind: "binding", arm,
                  actions: ACTIONS_FOR("binding", arm),
                  reports: TRIGGERS_FOR.binding,
                };
              }),
            ...match.structuresOf("player")
              .filter((structure) => structure.kind !== "depot")
              .map((structure) => ({
                actor: structure.id, kind: "structure", name: structure.name,
                actions: ACTIONS_FOR("structure", null),
                reports: TRIGGERS_FOR.structure,
              })),
            { actor: "chest", kind: "chest", actions: [], reports: TRIGGERS_FOR.chest },
          ],
          rules: match.rules.filter((rule) => rule.side === "player").map((rule) => ({
            id: rule.id,
            enabled: rule.enabled,
            reads: describeRule(rule, name),
            fired: rule.fired,
            cooldownLeft: Math.round(rule.cooldownLeft * 10) / 10,
          })),
        },
      });
    }, { readOnlyHint: true }),

  tool("set_match", "Set up the match",
    "Choose the ground, the length and the opposition. Only before the battle starts.",
    {
      type: "object", additionalProperties: false,
      properties: {
        mapId: { enum: [...MAP_IDS] },
        mapArea: {
          enum: FIELD_SIZES.map((size) => size.area),
          description: "How much ground: 1 compact, 2 standard, 5 grand.",
        },
        timeLimitS: { type: "integer", minimum: 120, maximum: 3600 },
        difficulty: { type: "integer", minimum: 1, maximum: 3 },
      },
    },
    (input) => {
      const difficulty = quality(input.difficulty);
      return wrap(match.setSettings({
        mapId: oneOf(MAP_IDS, input.mapId) as MapId | undefined,
        mapArea: num(input.mapArea),
        timeLimitS: num(input.timeLimitS),
        difficulty,
      }));
    }, { readOnlyHint: false }),

  tool("start_battle", "Take the field",
    "Begin. Both sides deploy a garrison at their headquarters and the clock runs.",
    empty,
    (input) => {
      if (Object.keys(input).length) return fail("invalid_input", "start_battle takes no parameters.");
      return wrap(startBattle(match));
    }, { readOnlyHint: false }),

  tool("set_paused", "Pause or resume", "Halt or resume the clock without leaving the field.",
    { type: "object", additionalProperties: false, required: ["paused"], properties: { paused: { type: "boolean" } } },
    (input) => {
      const paused = bool(input.paused);
      if (paused === undefined) return fail("invalid_input", "paused must be a boolean.");
      return wrap(match.setPaused(paused));
    }, { readOnlyHint: false }),

  tool("recruit", "Recruit at a base",
    "Spend crates to raise a new formation at one of your works. It takes time and arrives with a name of its own. "
    + "A work whose supply route is cut cannot recruit.",
    {
      type: "object", additionalProperties: false, required: ["structureId", "type", "count"],
      properties: {
        structureId: { type: "string", description: "From overview.structures — the base to raise it at." },
        type: { enum: [...UNIT_TYPES] },
        count: { type: "integer", minimum: 1, maximum: 60 },
        grade: { type: "integer", minimum: 1, maximum: 3, description: "Quality. 2 by default; better costs more and takes longer." },
      },
    },
    (input) => {
      const structureId = text(input.structureId, 24);
      const type = oneOf(UNIT_TYPES, input.type);
      const count = num(input.count);
      if (!structureId || !type || count === undefined) return fail("invalid_input", "structureId, type and count are required.");
      return wrap(recruit(match, structureId, type, Math.round(count), quality(input.grade) ?? 2));
    }, { readOnlyHint: false }),

  tool("build_work", "Raise a work",
    "Put a work on a cell. It must sit within reach of your existing network, clear of other works, and on "
    + "ground the enemy does not interdict. Each kind wants particular ground beside it and is stronger or "
    + "faster when it gets it: "
    + WORK_KINDS.map((kind) => `${kind} (${WORKS[kind].cost} crates, ${WORKS[kind].wants.label.toLowerCase()})`).join("; ")
    + ". Call inspect_cell first if you are unsure what is on the ground.",
    {
      type: "object", additionalProperties: false, required: ["kind", "x", "y"],
      properties: {
        kind: { enum: [...WORK_KINDS], description: "Which work to raise." },
        x: { type: "integer" }, y: { type: "integer" },
      },
    },
    (input) => {
      const at = cell(input);
      if (!at) return fail("invalid_input", "x and y must be integers on the map.");
      const kind = WORK_KINDS.find((option) => option === input.kind);
      if (!kind) return fail("invalid_input", `kind must be one of ${WORK_KINDS.join(", ")}.`);
      return wrap(buildWork(match, kind, at));
    }, { readOnlyHint: false }),

  tool("issue", "Order a formation",
    "Give one formation a standing order. Orders that go somewhere need cells. "
    + "Everything here is also what a rule's action does, so an order you can give by hand is one a rule can give for you.",
    {
      type: "object", additionalProperties: false, required: ["name"],
      properties: {
        name: { type: "string" },
        order: { enum: [...ORDERS] },
        cells: CELLS_SCHEMA,
        shape: { enum: [...SHAPES] },
        spacing: { type: "number", minimum: 1, maximum: 8 },
        facing: { type: "number" },
        holdFire: { type: "boolean" },
        fireAtWill: { type: "boolean" },
        engageRange: { type: "number", minimum: 10, maximum: 400, description: "Metres. Below this they open fire." },
        priority: { enum: [...PRIORITIES] },
        load: { enum: [...LOADS] },
      },
    },
    (input) => {
      const name = text(input.name);
      if (!name) return fail("invalid_input", "name is required.");
      const parsedCells = input.cells === undefined ? undefined : cells(input.cells);
      if (input.cells !== undefined && !parsedCells) return fail("invalid_input", "cells must be a list of { x, y }.");
      return wrap(issue(match, name, {
        order: oneOf(ORDERS, input.order) as OrderKind | undefined,
        cells: parsedCells,
        shape: oneOf(SHAPES, input.shape) as Shape | undefined,
        spacing: num(input.spacing),
        facing: num(input.facing),
        holdFire: bool(input.holdFire),
        fireAtWill: bool(input.fireAtWill),
        engageRange: num(input.engageRange),
        priority: oneOf(PRIORITIES, input.priority) as Priority | undefined,
        load: oneOf(LOADS, input.load) as Load | undefined,
      }));
    }, { readOnlyHint: false }),

  tool("bind", "Form a new formation",
    "Group loose units under one name so they move and fight together.",
    {
      type: "object", additionalProperties: false, required: ["unitIds"],
      properties: {
        unitIds: { type: "array", items: { type: "string" }, maxItems: 200 },
        name: { type: "string", maxLength: 24 },
      },
    },
    (input) => {
      if (!Array.isArray(input.unitIds) || input.unitIds.some((id) => typeof id !== "string")) {
        return fail("invalid_input", "unitIds must be a list of unit ids.");
      }
      return wrap(bindUnits(match, input.unitIds as string[], text(input.name, 24)));
    }, { readOnlyHint: false }),

  tool("unbind", "Break up a formation", "Release a formation's units back to loose order.",
    { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" } } },
    (input) => {
      const name = text(input.name);
      if (!name) return fail("invalid_input", "name is required.");
      return wrap(unbind(match, name));
    }, { readOnlyHint: false }),

  tool("rename_binding", "Rename a formation",
    "Give a formation a name your rules can refer to.",
    {
      type: "object", additionalProperties: false, required: ["from", "to"],
      properties: { from: { type: "string" }, to: { type: "string", maxLength: 24 } },
    },
    (input) => {
      const from = text(input.from);
      const to = text(input.to, 24);
      if (!from || !to) return fail("invalid_input", "from and to are required.");
      return wrap(renameBinding(match, from, to));
    }, { readOnlyHint: false }),

  tool("add_rule", "Write a standing order",
    "The heart of the game. An order is written to one named formation or one named base and set off by one "
    + "named thing: \"Alpha attacks the attacker when it comes under fire\", \"Headquarters raises 16 infantry "
    + "when the war chest passes 800 crates\". Nothing in an order is a wildcard and every place it names is a "
    + "place you can point at. It then acts on its own, for the rest of the battle, with no second call. "
    + "Use list_rules for the vocabulary.",
    {
      type: "object", additionalProperties: false, required: ["watch", "trigger", "actor", "action"],
      properties: {
        watch: WATCH_SCHEMA,
        trigger: { enum: [...TRIGGERS], description: "What the watched thing has to do. A formation reports under_fire, spotted, weakened, arrived, idle, destroyed; a base reports threatened, supply_cut, supply_restored, captured, lost, destroyed; the chest reports supply_above." },
        threshold: { type: "number", description: "For 'weakened' a percentage of establishment, so 45 or 0.45 both mean forty-five percent; for 'supply_above' a number of crates." },
        actor: ACTOR_SCHEMA,
        action: { enum: [...ACTIONS], description: "A formation can march, hold, attack, retreat or stand in reserve; only cavalry can charge and only artillery can bombard; only a base can recruit." },
        place: PLACE_SCHEMA,
        unitType: { enum: [...UNIT_TYPES], description: "For the recruit action." },
        count: { type: "integer", minimum: 1, maximum: 60, description: "For the recruit action." },
        once: { type: "boolean", description: "Retire the order after it acts once." },
        cooldownS: { type: "number", minimum: 0, maximum: 600, description: "Seconds before it may act again." },
      },
    },
    (input) => {
      if (!oneOf(TRIGGERS, input.trigger)) return fail("invalid_input", `trigger must be one of ${TRIGGERS.join(", ")}.`);
      const patch = rulePatch(match, input);
      if (!patch.watch) return fail("invalid_input", "watch must name one formation, one structure id, or \"chest\".");
      if (!patch.actor) return fail("invalid_input", "actor must name one formation or one structure id.");
      const result = addRule(match, patch);
      if (!result.ok) return wrap(result);
      return json({ ok: true, data: { id: result.data.id, reads: describeRule(result.data, naming(match)) } });
    }, { readOnlyHint: false }),

  tool("update_rule", "Amend a standing order",
    "Change any part of an order already in the book. Only the fields you send are touched.",
    {
      type: "object", additionalProperties: false, required: ["id"],
      properties: {
        id: { type: "string" },
        enabled: { type: "boolean" },
        watch: WATCH_SCHEMA,
        trigger: { enum: [...TRIGGERS] },
        threshold: { type: "number" },
        actor: ACTOR_SCHEMA,
        action: { enum: [...ACTIONS] },
        place: PLACE_SCHEMA,
        unitType: { enum: [...UNIT_TYPES] },
        count: { type: "integer", minimum: 1, maximum: 60 },
        once: { type: "boolean" },
        cooldownS: { type: "number", minimum: 0, maximum: 600 },
      },
    },
    (input) => {
      const id = text(input.id, 24);
      if (!id) return fail("invalid_input", "id is required.");
      const result = updateRule(match, id, rulePatch(match, input));
      if (!result.ok) return wrap(result);
      return json({ ok: true, data: { id: result.data.id, reads: describeRule(result.data, naming(match)) } });
    }, { readOnlyHint: false }),

  tool("remove_rule", "Strike a standing order", "Take a line out of the book.",
    { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
    (input) => {
      const id = text(input.id, 24);
      if (!id) return fail("invalid_input", "id is required.");
      return wrap(removeRule(match, id));
    }, { readOnlyHint: false }),
];

export const registerWebMCPTools = async (match: Match) => {
  const modelContext = document.modelContext;
  if (!modelContext) {
    window.__OVERLOADED_WEBMCP__ = { registered: false, count: 0 };
    return { registered: false, count: 0 };
  }
  const tools = createTools(match);
  try {
    await Promise.all(tools.map((definition) => modelContext.registerTool(definition)));
    window.__OVERLOADED_WEBMCP__ = { registered: true, count: tools.length };
    return { registered: true, count: tools.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool registration failed.";
    window.__OVERLOADED_WEBMCP__ = { registered: false, count: 0, error: message };
    return { registered: false, count: 0, error: message };
  }
};
