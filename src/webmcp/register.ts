import {
  addRule, bindUnits, buildFob, inspectBinding, inspectCell, inspectContact, inspectStructure,
  issue, overview, readAlerts, recruit, removeRule, renameBinding, startBattle, unbind, updateRule,
} from "../domain/commands";
import {
  ACTIONS, EVENTS, LOADS, MAP_IDS, ORDERS, PRIORITIES, SHAPES, TARGET_KINDS, UNIT_TYPES, WHERE,
} from "../domain/constants";
import type { Match } from "../domain/match";
import { describeRule, EVENT_TEXT, ACTION_TEXT } from "../domain/rules";
import { targetLabel } from "../domain/observe";
import type {
  Cell, Load, MapId, OrderKind, Priority, Quality, Rule, RuleTarget, Shape,
} from "../domain/types";

type UnknownRecord = Record<string, unknown>;

const json = (value: unknown) => JSON.stringify(value);
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
 * `{ kind, ref }`, and the shorthand of a bare name.
 *
 * A bare string is checked against the live structure ids first, so
 * `"base1"` names a base and `"Alpha"` names a formation without the caller
 * having to say which.
 */
const target = (match: Match, value: unknown): RuleTarget | undefined => {
  if (typeof value === "string") {
    const kind = oneOf(TARGET_KINDS, value);
    if (kind) return { kind };
    return match.structures.has(value) ? { kind: "structure", ref: value } : { kind: "binding", ref: value };
  }
  if (!isRecord(value)) return undefined;
  const kind = oneOf(TARGET_KINDS, value.kind);
  if (!kind) return undefined;
  const ref = text(value.ref, 40);
  if ((kind === "binding" || kind === "structure") && !ref) return undefined;
  return ref ? { kind, ref } : { kind };
};

const rulePatch = (match: Match, input: UnknownRecord): Partial<Rule> => {
  const patch: Partial<Rule> = {};
  const name = text(input.name, 40);
  if (name) patch.name = name;
  const enabled = bool(input.enabled);
  if (enabled !== undefined) patch.enabled = enabled;
  if (input.subject !== undefined) {
    const parsed = target(match, input.subject);
    if (parsed) patch.subject = parsed;
  }
  if (input.actor !== undefined) {
    const parsed = target(match, input.actor);
    if (parsed) patch.actor = parsed;
  }
  const event = oneOf(EVENTS, input.event);
  if (event) patch.event = event;
  const action = oneOf(ACTIONS, input.action);
  if (action) patch.action = action;
  const where = oneOf(WHERE, input.where);
  if (where) patch.where = where;
  const threshold = num(input.threshold);
  if (threshold !== undefined) patch.threshold = threshold;
  const parsedCells = cells(input.cells);
  if (parsedCells) patch.cells = parsedCells;
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

const TARGET_SCHEMA = {
  description: "Either a shorthand string — a binding name like \"Alpha\", a structure id like \"s3\", or one of "
    + TARGET_KINDS.join(", ") + " — or an object { kind, ref }.",
  anyOf: [
    { type: "string" },
    {
      type: "object", additionalProperties: false, required: ["kind"],
      properties: { kind: { enum: [...TARGET_KINDS] }, ref: { type: "string" } },
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
      return json({ ok: true, data: inspectCell(match, at) });
    }, { readOnlyHint: true }),

  tool("inspect_contact", "Inspect a contact",
    "What is known about one visible enemy contact. Distance decides how much that is.",
    { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
    (input) => {
      const id = text(input.id, 24);
      if (!id) return fail("invalid_input", "id is required.");
      return json({ ok: true, data: inspectContact(match, id) });
    }, { readOnlyHint: true }),

  tool("read_alerts", "Read dispatches",
    "The dispatch feed, newest first: what happened, to whom, and which standing order answered it.",
    {
      type: "object", additionalProperties: false,
      properties: { limit: { type: "integer", minimum: 1, maximum: 60 } },
    },
    (input) => json({ ok: true, data: readAlerts(match, "player", num(input.limit) ?? 20) }),
    { readOnlyHint: true }),

  tool("list_rules", "Read the order book",
    "Every standing order you hold, as the English sentence it reads on screen, plus how many times it has acted.",
    empty,
    (input) => {
      if (Object.keys(input).length) return fail("invalid_input", "list_rules takes no parameters.");
      const label = (item: RuleTarget) => targetLabel(match, item);
      return json({
        ok: true,
        data: {
          vocabulary: {
            events: EVENTS.map((event) => ({ event, reads: EVENT_TEXT[event] })),
            actions: ACTIONS.map((action) => ({ action, reads: ACTION_TEXT[action] })),
            where: [...WHERE],
            targets: [...TARGET_KINDS],
          },
          rules: match.rules.filter((rule) => rule.side === "player").map((rule) => ({
            id: rule.id,
            name: rule.name,
            enabled: rule.enabled,
            reads: describeRule(rule, label),
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
        timeLimitS: { type: "integer", minimum: 120, maximum: 3600 },
        difficulty: { type: "integer", minimum: 1, maximum: 3 },
      },
    },
    (input) => {
      const difficulty = quality(input.difficulty);
      return wrap(match.setSettings({
        mapId: oneOf(MAP_IDS, input.mapId) as MapId | undefined,
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

  tool("build_fob", "Raise a redoubt",
    "Put a forward work on a cell. It must sit within reach of your existing network, clear of other works, "
    + "and on ground the enemy does not interdict. It extends supply and pays a small yield of its own.",
    {
      type: "object", additionalProperties: false, required: ["x", "y"],
      properties: { x: { type: "integer" }, y: { type: "integer" } },
    },
    (input) => {
      const at = cell(input);
      if (!at) return fail("invalid_input", "x and y must be integers on the map.");
      return wrap(buildFob(match, at));
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
    "The heart of the game. A rule reads: WHEN <event> happens to <subject>, <actor> performs <action> at <where>. "
    + "The actor may be the subject itself (\"self\"), a named formation, a base, or \"nearest_reserve\" — whichever "
    + "idle formation is closest. Rules run without you and never need a second call. "
    + "Use list_rules for the full vocabulary and what each word means.",
    {
      type: "object", additionalProperties: false, required: ["event"],
      properties: {
        name: { type: "string", maxLength: 40, description: "What this line is for, in your own words." },
        subject: TARGET_SCHEMA,
        event: { enum: [...EVENTS] },
        threshold: { type: "number", description: "For 'weakened' a percentage of establishment; for 'timer' a count of seconds; for 'idle' seconds idle." },
        actor: TARGET_SCHEMA,
        action: { enum: [...ACTIONS] },
        where: { enum: [...WHERE], description: "Which cell the action aims at." },
        cells: CELLS_SCHEMA,
        unitType: { enum: [...UNIT_TYPES], description: "For the recruit action." },
        count: { type: "integer", minimum: 1, maximum: 60, description: "For the recruit action." },
        once: { type: "boolean", description: "Retire the line after it acts once." },
        cooldownS: { type: "number", minimum: 0, maximum: 600, description: "Seconds before it may act again." },
      },
    },
    (input) => {
      if (!oneOf(EVENTS, input.event)) return fail("invalid_input", `event must be one of ${EVENTS.join(", ")}.`);
      const result = addRule(match, rulePatch(match, input));
      if (!result.ok) return wrap(result);
      const label = (item: RuleTarget) => targetLabel(match, item);
      return json({ ok: true, data: { id: result.data.id, reads: describeRule(result.data, label) } });
    }, { readOnlyHint: false }),

  tool("update_rule", "Amend a standing order",
    "Change any clause of a line already in the book. Only the fields you send are touched.",
    {
      type: "object", additionalProperties: false, required: ["id"],
      properties: {
        id: { type: "string" },
        name: { type: "string", maxLength: 40 },
        enabled: { type: "boolean" },
        subject: TARGET_SCHEMA,
        event: { enum: [...EVENTS] },
        threshold: { type: "number" },
        actor: TARGET_SCHEMA,
        action: { enum: [...ACTIONS] },
        where: { enum: [...WHERE] },
        cells: CELLS_SCHEMA,
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
      const label = (item: RuleTarget) => targetLabel(match, item);
      return json({ ok: true, data: { id: result.data.id, reads: describeRule(result.data, label) } });
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
