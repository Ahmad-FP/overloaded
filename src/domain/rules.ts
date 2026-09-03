import type {
  ActionKind, Alert, Cell, EventKind, GameEvent, Rule, RuleTarget, Side,
  UnitType, WhereKind,
} from "./types";

/**
 * The standing-orders book.
 *
 * A rule is one English sentence with the nouns and verbs swapped for chips:
 *
 *   WHEN <event> happens to <subject>, <actor> performs <action> at <where>.
 *
 * The subject raises an alert; the actor answers it. Subject and actor may be
 * the same thing, which is how a battalion reacts to its own trouble, and the
 * actor may be a place rather than a formation, which is how a base answers a
 * raid by raising more men.
 *
 * Everything here is data. The match emits `GameEvent`s and calls `runRules`;
 * nothing in this file touches units directly, so the same book is legible to
 * the player, to the bot, and to an agent over WebMCP without three copies of
 * the logic.
 */

export const EVENT_TEXT: Record<EventKind, string> = {
  spotted: "sights the enemy",
  under_fire: "comes under fire",
  weakened: "falls below strength",
  arrived: "reaches its objective",
  idle: "has nothing to do",
  threatened: "is threatened",
  supply_cut: "loses its supply line",
  supply_restored: "is back in supply",
  captured: "is taken",
  lost: "is lost",
  destroyed: "is destroyed",
  timer: "every so often",
};

export const ACTION_TEXT: Record<ActionKind, string> = {
  move: "march",
  hold: "hold",
  attack_area: "attack",
  bombard: "bombard",
  charge: "charge",
  retreat: "fall back",
  reserve: "go to reserve",
  build_fob: "raise a redoubt",
  recruit: "raise men",
  alert_only: "report only",
};

export const WHERE_TEXT: Record<WhereKind, string> = {
  event_cell: "the sighting",
  subject_cell: "the caller",
  actor_cell: "where it stands",
  fixed: "a marked place",
};

/** Which events can be raised by which kind of subject. */
export const EVENTS_FOR: Record<"binding" | "structure", EventKind[]> = {
  binding: ["spotted", "under_fire", "weakened", "arrived", "idle", "destroyed", "timer"],
  structure: ["threatened", "supply_cut", "supply_restored", "captured", "lost", "destroyed", "timer"],
};

export const makeRule = (id: string, side: Side, patch: Partial<Rule> = {}): Rule => ({
  id,
  side,
  name: patch.name ?? "Standing order",
  enabled: patch.enabled ?? true,
  subject: patch.subject ?? { kind: "any_binding" },
  event: patch.event ?? "spotted",
  threshold: patch.threshold ?? 50,
  actor: patch.actor ?? { kind: "self" },
  action: patch.action ?? "attack_area",
  where: patch.where ?? "event_cell",
  cells: patch.cells ?? [],
  unitType: patch.unitType ?? "infantry",
  count: patch.count ?? 8,
  once: patch.once ?? false,
  cooldownS: patch.cooldownS ?? 20,
  cooldownLeft: 0,
  fired: 0,
  timerLeft: patch.threshold ?? 30,
});

/** Does this rule's subject clause name the thing the event happened to? */
export const subjectMatches = (
  target: RuleTarget,
  kind: "binding" | "structure",
  id: string,
  name: string,
) => {
  switch (target.kind) {
    case "binding":
      return kind === "binding" && target.ref === name;
    case "structure":
      return kind === "structure" && target.ref === id;
    case "any_binding":
      return kind === "binding";
    case "any_structure":
      return kind === "structure";
    default:
      return false;
  }
};

/**
 * What the actor clause resolves to, given the event that fired.
 *
 * `self` is the caller — the whole point of the "it can also be the alerting
 * unit" case. `nearest_reserve` is the sugar that makes a book of two rules
 * behave like a real chain of command: whoever is idle and closest answers.
 */
export type ActorRef = { kind: "binding" | "structure"; id: string; name: string };

export type RuleWorld = {
  bindingByName: (name: string) => ActorRef | null;
  structureById: (id: string) => ActorRef | null;
  /** Idle friendly formations, nearest first, for `nearest_reserve`. */
  reservesNear: (cell: Cell, side: Side) => ActorRef[];
  cellOfActor: (ref: ActorRef) => Cell;
  /** Do the thing. Returns a sentence for the alert feed, or null if it could not. */
  perform: (
    ref: ActorRef,
    action: ActionKind,
    cells: Cell[],
    unitType: UnitType,
    count: number,
  ) => string | null;
  emitAlert: (alert: Omit<Alert, "id">) => void;
  nextId: (prefix: string) => string;
  clock: number;
};

const resolveActor = (
  rule: Rule,
  event: GameEvent,
  world: RuleWorld,
): ActorRef | null => {
  switch (rule.actor.kind) {
    case "self":
      return event.subjectKind === "binding"
        ? world.bindingByName(event.subjectName)
        : world.structureById(event.subjectId);
    case "binding":
      return rule.actor.ref ? world.bindingByName(rule.actor.ref) : null;
    case "structure":
      return rule.actor.ref ? world.structureById(rule.actor.ref) : null;
    case "nearest_reserve":
      return world.reservesNear(event.eventCell, rule.side)[0] ?? null;
    default:
      return null;
  }
};

const resolveCells = (rule: Rule, event: GameEvent, actor: ActorRef, world: RuleWorld): Cell[] => {
  switch (rule.where) {
    case "event_cell":
      return [event.eventCell];
    case "subject_cell":
      return [event.cell];
    case "actor_cell":
      return [world.cellOfActor(actor)];
    default:
      return rule.cells.length ? rule.cells : [event.eventCell];
  }
};

/**
 * Match one batch of events against the book.
 *
 * Every event produces an alert whether or not a rule answers it, because a
 * report the player never sees is a report that did not happen. When a rule
 * does answer, the alert carries the rule's name and what it ordered.
 */
export const runRules = (rules: Rule[], events: GameEvent[], world: RuleWorld) => {
  for (const event of events) {
    let answered = false;
    for (const rule of rules) {
      if (!rule.enabled || rule.side !== event.side) continue;
      if (rule.event !== event.event) continue;
      if (rule.cooldownLeft > 0) continue;
      if (rule.once && rule.fired > 0) continue;
      if (!subjectMatches(rule.subject, event.subjectKind, event.subjectId, event.subjectName)) continue;

      const actor = resolveActor(rule, event, world);
      if (!actor) continue;
      const response = rule.action === "alert_only"
        ? `${rule.name}: noted.`
        : world.perform(actor, rule.action, resolveCells(rule, event, actor, world), rule.unitType, rule.count);
      if (!response) continue;

      rule.fired += 1;
      rule.cooldownLeft = rule.cooldownS;
      world.emitAlert({
        atS: world.clock,
        side: event.side,
        event: event.event,
        subject: event.subjectName,
        subjectId: event.subjectId,
        cell: event.eventCell,
        text: event.text,
        ruleId: rule.id,
        ruleName: rule.name,
        response,
      });
      answered = true;
      break;
    }
    if (!answered) {
      world.emitAlert({
        atS: world.clock,
        side: event.side,
        event: event.event,
        subject: event.subjectName,
        subjectId: event.subjectId,
        cell: event.eventCell,
        text: event.text,
        ruleId: null,
        ruleName: null,
        response: null,
      });
    }
  }
};

export const coolRules = (rules: Rule[], dt: number) => {
  for (const rule of rules) {
    if (rule.cooldownLeft > 0) rule.cooldownLeft = Math.max(0, rule.cooldownLeft - dt);
  }
};

/** One readable line for a rule, used by the book, the tooltip and the tools. */
export const describeRule = (rule: Rule, label: (target: RuleTarget) => string) => {
  const when = rule.event === "timer"
    ? `Every ${Math.round(rule.threshold)}s`
    : `When ${label(rule.subject)} ${EVENT_TEXT[rule.event]}${rule.event === "weakened" ? ` (${Math.round(rule.threshold)}%)` : ""}`;
  const then = rule.action === "recruit"
    ? `${label(rule.actor)} raises ${rule.count} ${rule.unitType}`
    : rule.action === "alert_only"
      ? `report it`
      : `${label(rule.actor)} ${ACTION_TEXT[rule.action]} at ${WHERE_TEXT[rule.where]}`;
  return `${when}, ${then}.`;
};
