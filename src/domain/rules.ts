import { ACTIONS, CONTACT_TRIGGERS } from "./constants";
import type {
  ActionKind, Alert, Cell, GameEvent, OrderActor, OrderPlace, Rule, Side, Trigger,
  UnitType, Watched,
} from "./types";

/**
 * Standing orders.
 *
 * An order is written to one named formation or one named building and set off
 * by one named thing: "Alpha attacks the attacker when it comes under fire",
 * "Headquarters raises 16 infantry when the war chest passes 800 crates".
 * Nothing in it is a wildcard, and nothing in it is a place the player cannot
 * point at, because an order that fires on "any formation" at "where it
 * happened" is an order nobody can predict.
 *
 * The book is not swept on a timer. An order belongs to the thing it watches:
 * the match hands each report straight to `fireOrders` in the instant it is
 * raised, and the orders written against that thing go out with it.
 *
 * Everything here is data. The same vocabulary is exported into the WebMCP
 * schema, so an order written by the player and one written by an agent are
 * the same object.
 */

/** What the watched thing has to do, in the third person. */
export const TRIGGER_TEXT: Record<Trigger, string> = {
  under_fire: "comes under fire",
  spotted: "sights the enemy",
  weakened: "is cut down",
  arrived: "reaches its ground",
  idle: "has nothing to do",
  threatened: "has the enemy at its gate",
  supply_cut: "loses its supply line",
  supply_restored: "is back in supply",
  captured: "is taken",
  lost: "is lost",
  destroyed: "is destroyed",
  supply_above: "passes",
};

/** The same verbs written as an order you would give. */
export const ACTION_ORDER: Record<ActionKind, string> = {
  move: "March on",
  hold: "Hold",
  attack_area: "Attack",
  bombard: "Bombard",
  charge: "Charge",
  retreat: "Fall back",
  reserve: "Stand in reserve",
  recruit: "Raise",
};

/** Third person, for the line the order reads as. */
const ACTION_DOES: Record<ActionKind, string> = {
  move: "marches on",
  hold: "holds",
  attack_area: "attacks",
  bombard: "bombards",
  charge: "charges",
  retreat: "falls back",
  reserve: "stands in reserve",
  recruit: "raises",
};

/** Which watches a thing of this kind can report. */
export const TRIGGERS_FOR: Record<Watched["kind"], Trigger[]> = {
  binding: ["under_fire", "spotted", "weakened", "arrived", "idle", "destroyed"],
  structure: ["threatened", "supply_cut", "supply_restored", "captured", "lost", "destroyed"],
  chest: ["supply_above"],
};

/**
 * Which orders this actor can be given.
 *
 * A battery does not charge and a squadron does not bombard, so the dropdown
 * never offers either. A building can only raise men.
 */
export const ACTIONS_FOR = (actor: OrderActor["kind"], arm: UnitType | null): ActionKind[] => {
  if (actor === "structure") return ["recruit"];
  return ACTIONS.filter((action) => {
    if (action === "recruit") return false;
    if (action === "charge") return arm === "cavalry";
    if (action === "bombard") return arm === "artillery";
    return true;
  });
};

/** Orders that have to be given a piece of ground. */
export const NEEDS_PLACE = (action: ActionKind) =>
  action === "move" || action === "attack_area" || action === "bombard"
  || action === "charge" || action === "hold";

/** Only a watch that sees an enemy can send anyone after "the attacker". */
export const HAS_ATTACKER = (trigger: Trigger): boolean =>
  (CONTACT_TRIGGERS as readonly string[]).includes(trigger);

/**
 * A `weakened` threshold is a percentage of establishment, but 0.45 is just as
 * natural a way to write forty-five percent, and it used to be taken at face
 * value: the order read "(0%)" and never fired, because no battalion falls
 * below half a percent of strength. Anything at or under one is a fraction.
 */
export const readThreshold = (trigger: Trigger, value: number) =>
  trigger === "weakened" && value > 0 && value <= 1 ? value * 100 : value;

export const makeRule = (id: string, side: Side, patch: Partial<Rule> = {}): Rule => {
  const trigger = patch.trigger ?? "under_fire";
  return {
    id,
    side,
    enabled: patch.enabled ?? true,
    watch: patch.watch ?? { kind: "binding", ref: "" },
    trigger,
    threshold: readThreshold(trigger, patch.threshold ?? (trigger === "supply_above" ? 800 : 40)),
    actor: patch.actor ?? { kind: "binding", ref: "" },
    action: patch.action ?? "attack_area",
    place: patch.place ?? null,
    unitType: patch.unitType ?? "infantry",
    count: patch.count ?? 12,
    once: patch.once ?? false,
    cooldownS: patch.cooldownS ?? 20,
    cooldownLeft: 0,
    fired: 0,
  };
};

/** Is this order held by the thing that just reported? */
export const watches = (rule: Rule, event: GameEvent) => {
  if (rule.trigger !== event.event) return false;
  if (rule.watch.kind !== event.subjectKind) return false;
  if (rule.watch.kind === "chest") return true;
  if (rule.watch.kind === "binding") return rule.watch.ref === event.subjectName;
  return rule.watch.ref === event.subjectId;
};

export type ActorRef = { kind: "binding" | "structure"; id: string; name: string };

export type RuleWorld = {
  /** What the order's nouns are called, so a dispatch reads as the order does. */
  name: Naming;
  bindingByName: (name: string) => ActorRef | null;
  structureById: (id: string) => ActorRef | null;
  cellOfActor: (ref: ActorRef) => Cell;
  /** Do the thing. Returns a sentence for the dispatches, or null if it could not. */
  perform: (
    ref: ActorRef,
    action: ActionKind,
    cells: Cell[],
    unitType: UnitType,
    count: number,
  ) => string | null;
  emitAlert: (alert: Omit<Alert, "id">) => void;
  clock: number;
};

const resolveActor = (rule: Rule, world: RuleWorld): ActorRef | null =>
  rule.actor.kind === "binding"
    ? world.bindingByName(rule.actor.ref)
    : world.structureById(rule.actor.ref);

/** The ground the order aims at, or null if it named something that is gone. */
const resolvePlace = (rule: Rule, event: GameEvent, actor: ActorRef, world: RuleWorld): Cell | null => {
  if (!NEEDS_PLACE(rule.action)) return null;
  const place = rule.place;
  if (!place) return rule.action === "hold" ? world.cellOfActor(actor) : null;
  switch (place.kind) {
    case "attacker": return event.eventCell;
    case "point": return place.cell;
    case "binding": {
      const ref = world.bindingByName(place.ref);
      return ref ? world.cellOfActor(ref) : null;
    }
    default: {
      const ref = world.structureById(place.ref);
      return ref ? world.cellOfActor(ref) : null;
    }
  }
};

/**
 * Hand one report to the orders held against it.
 *
 * Called the instant the report is raised, not on a sweep, so an order is part
 * of the thing that carries it. Every report reaches the dispatches whether or
 * not an order answered it, because a report the player never sees is a report
 * that did not happen.
 */
export const fireOrders = (rules: Rule[], event: GameEvent, world: RuleWorld) => {
  const say = (rule: Rule | null, response: string | null) => world.emitAlert({
    atS: world.clock,
    side: event.side,
    event: event.event,
    subject: event.subjectName,
    subjectId: event.subjectId,
    cell: event.eventCell,
    text: event.text,
    ruleId: rule?.id ?? null,
    ruleName: rule ? orderText(rule, world.name) : null,
    response,
  });

  for (const rule of rules) {
    if (!rule.enabled || rule.side !== event.side) continue;
    if (rule.cooldownLeft > 0 || (rule.once && rule.fired > 0)) continue;
    if (!watches(rule, event)) continue;

    const actor = resolveActor(rule, world);
    if (!actor) continue;
    const place = resolvePlace(rule, event, actor, world);
    if (NEEDS_PLACE(rule.action) && !place) continue;
    const response = world.perform(actor, rule.action, place ? [place] : [], rule.unitType, rule.count);
    if (!response) continue;

    rule.fired += 1;
    rule.cooldownLeft = rule.cooldownS;
    say(rule, response);
    return;
  }
  say(null, null);
};

export const coolRules = (rules: Rule[], dt: number) => {
  for (const rule of rules) {
    if (rule.cooldownLeft > 0) rule.cooldownLeft = Math.max(0, rule.cooldownLeft - dt);
  }
};

// -- how an order reads ------------------------------------------------------

export type Naming = {
  watched: (watch: Watched) => string;
  actor: (actor: OrderActor) => string;
  place: (place: OrderPlace, trigger: Trigger) => string;
};

/** What the order tells someone to do. This is the line the book shows. */
export const orderText = (rule: Rule, name: Naming) => {
  const who = name.actor(rule.actor);
  if (rule.action === "recruit") return `${who} raises ${rule.count} ${rule.unitType}`;
  const does = ACTION_DOES[rule.action];
  if (!NEEDS_PLACE(rule.action)) return `${who} ${does}`;
  if (!rule.place) return rule.action === "hold" ? `${who} holds its ground` : `${who} ${does}`;
  return `${who} ${does} ${name.place(rule.place, rule.trigger)}`;
};

/** What sets it off. Kept out of the book list and shown in the order card. */
export const watchText = (rule: Rule, name: Naming) => {
  const what = name.watched(rule.watch);
  if (rule.trigger === "supply_above") return `${what} passes ${Math.round(rule.threshold)} crates`;
  if (rule.trigger === "weakened") return `${what} is cut below ${Math.round(rule.threshold)}% of its strength`;
  return `${what} ${TRIGGER_TEXT[rule.trigger]}`;
};

/**
 * The whole order in one line, order first.
 *
 * Used by the order card, the dispatches and the WebMCP tools, so all three
 * read the same words.
 */
export const describeRule = (rule: Rule, name: Naming) => {
  const sameThing = rule.watch.kind !== "chest" && rule.actor.kind === rule.watch.kind
    && rule.actor.ref === rule.watch.ref;
  const when = sameThing
    ? (rule.trigger === "weakened"
      ? `it is cut below ${Math.round(rule.threshold)}% of its strength`
      : `it ${TRIGGER_TEXT[rule.trigger]}`)
    : watchText(rule, name);
  return `${orderText(rule, name)} when ${when}.`;
};
