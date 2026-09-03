import type { Match } from "../domain/match";
import {
  ACTION_ORDER, ACTIONS_FOR, describeRule, HAS_ATTACKER, NEEDS_PLACE, orderText,
  TRIGGER_TEXT, TRIGGERS_FOR, watchText,
} from "../domain/rules";
import { UNIT_TYPES } from "../domain/constants";
import type {
  ActionKind, Binding, Cell, OrderActor, OrderPlace, Rule, Trigger, UnitType, Watched,
} from "../domain/types";
import { ORDER_DOING } from "./keys";
import { panel } from "./panel";
import { closeMenus, dropdown, type Option } from "./pick";

/**
 * The orders panel.
 *
 * Two lists, because a commander wants two different things. *In hand* is what
 * the army is doing this minute, one line per formation. *Standing* is what it
 * will do without being told, and each of those reads as the order itself --
 * who acts, what they do, and the ground they do it on. What sets an order off
 * is not in the list: it belongs to the order card, behind the gear, because a
 * list that prints both halves of every line is a specification, not a
 * briefing.
 *
 * The card is written to one formation or one base. Every dropdown on it is
 * filtered by what the rest of the card already says, so a battery is never
 * offered a charge and a base is never offered a march.
 */

export type RuleBookHandlers = {
  onChange: (id: string, patch: Partial<Rule>) => void;
  onRemove: (id: string) => void;
  onAdd: (seed: Partial<Rule>) => void;
  onFocus: (rule: Rule) => void;
  /** Send the player to the map to mark the ground this order aims at. */
  onPickPlace: (id: string) => void;
  onGoTo: (cell: Cell) => void;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const GEAR = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 3.2v2.3M12 18.5v2.3M20.8 12h-2.3M5.5 12H3.2M18.2 5.8l-1.6 1.6M7.4 16.6l-1.6 1.6M18.2 18.2l-1.6-1.6M7.4 7.4 5.8 5.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

const watchKey = (watch: Watched) => watch.kind === "chest" ? "chest" : `${watch.kind[0]}:${watch.ref}`;
const actorKey = (actor: OrderActor) => `${actor.kind[0]}:${actor.ref}`;
const placeKey = (place: OrderPlace | null) => {
  if (!place) return "";
  if (place.kind === "attacker") return "attacker";
  if (place.kind === "point") return "point";
  return `${place.kind[0]}:${place.ref}`;
};

const refOf = (key: string): { kind: "binding" | "structure"; ref: string } | null => {
  const [head, ...rest] = key.split(":");
  const ref = rest.join(":");
  if (!ref) return null;
  return { kind: head === "b" ? "binding" : "structure", ref };
};

export class RuleBook {
  readonly root: HTMLElement;
  private inHand = el("div", "order-live");
  private list = el("div", "book-list");
  private signature = "";
  private liveSignature = "";
  private scrim = el("div", "scrim");
  private sheet = el("div", "panel sheet");
  private editing: string | null = null;
  private editSignature = "";
  /** Set while a new order is being written, so its card opens on arrival. */
  private opening = false;

  constructor(private handlers: RuleBookHandlers) {
    const shell = panel("Orders", "book", "right");
    this.root = shell.root;
    const add = el("button", "ghost", "+ New");
    add.title = "Write a standing order";
    add.addEventListener("click", () => this.writeNew());
    shell.tools.append(add);

    shell.body.append(this.band("In hand"), this.inHand);
    shell.body.append(this.band("Standing"), this.list);

    this.scrim.dataset.on = "0";
    this.scrim.append(this.sheet);
    this.scrim.addEventListener("pointerdown", (event) => {
      if (event.target === this.scrim) this.close();
    });
    // The board reads bare keys as orders; the card is a form, so nothing typed
    // into it reaches the field.
    for (const kind of ["keydown", "keyup", "keypress"] as const) {
      this.sheet.addEventListener(kind, (event) => event.stopPropagation());
    }
    document.body.append(this.scrim);
  }

  private band(title: string) {
    return el("h3", "order-band", title);
  }

  /** Open a fresh card, written to whatever the player had selected. */
  writeNew(seed: Partial<Rule> = {}) {
    this.opening = true;
    this.handlers.onAdd(seed);
  }

  /** Write an order to this formation, from the field or the roster. */
  ordersFor(binding: Binding) {
    const at = { kind: "binding" as const, ref: binding.name };
    this.writeNew({ watch: at, actor: at, trigger: "under_fire", action: "attack_area", place: { kind: "attacker" } });
  }

  /** Write an order to this base. */
  ordersForBase(id: string) {
    this.writeNew({
      watch: { kind: "chest" }, trigger: "supply_above", threshold: 800,
      actor: { kind: "structure", ref: id }, action: "recruit", place: null,
    });
  }

  /** Bring a card back up after the player has marked ground on the map. */
  reopen(id: string) {
    this.editing = id;
    this.editSignature = "";
    this.scrim.dataset.on = "1";
  }

  private close() {
    closeMenus();
    this.editing = null;
    this.editSignature = "";
    this.scrim.dataset.on = "0";
  }

  private ruleKey(rule: Rule) {
    return `${rule.id}${rule.enabled}${watchKey(rule.watch)}${rule.trigger}${actorKey(rule.actor)}`
      + `${rule.action}${placeKey(rule.place)}${rule.place?.kind === "point" ? `${rule.place.cell.x},${rule.place.cell.y}` : ""}`
      + `${rule.threshold}${rule.count}${rule.unitType}${rule.once}${rule.cooldownS}`;
  }

  /** Rebuild only when the shape of the book changes, not every frame. */
  update(match: Match) {
    this.paintLive(match);
    const rules = match.rules.filter((rule) => rule.side === "player");
    const names = [...match.bindings.values()].filter((binding) => binding.side === "player").map((binding) => binding.name).join(",");
    const works = match.structuresOf("player").map((structure) => structure.id).join(",");
    const signature = `${names}|${works}|${rules.map((rule) => this.ruleKey(rule)).join(";")}`;
    if (signature !== this.signature) {
      this.signature = signature;
      this.list.replaceChildren(...rules.map((rule) => this.row(match, rule)));
      if (!rules.length) this.list.append(el("p", "empty", "Nothing standing. The staff will wait to be told."));
      const fresh = rules[rules.length - 1];
      if (this.opening && fresh) {
        this.opening = false;
        this.reopen(fresh.id);
      }
    }

    const open = this.editing ? rules.find((rule) => rule.id === this.editing) : undefined;
    if (this.editing && !open) return this.close();
    if (open) {
      const key = `${names}|${works}|${this.ruleKey(open)}`;
      if (key !== this.editSignature) {
        this.editSignature = key;
        this.paintCard(match, open);
      }
    }
  }

  // -- what the army is doing now -------------------------------------------

  private paintLive(match: Match) {
    const mine = [...match.bindings.values()].filter((binding) =>
      binding.side === "player" && match.bindingUnits(binding).length > 0);
    const signature = mine.map((binding) => {
      const goal = binding.order.cells[0];
      return `${binding.name}:${binding.order.kind}:${goal ? `${goal.x},${goal.y}` : ""}`;
    }).join(";");
    if (signature === this.liveSignature) return;
    this.liveSignature = signature;

    this.inHand.replaceChildren(...mine.map((binding) => {
      const cell = match.bindingCell(binding);
      const row = el("button", "live-row");
      row.append(el("span", "live-name", binding.name));
      row.append(el("span", "live-doing", this.doingText(match, binding)));
      row.title = `Centre on ${binding.name}`;
      row.addEventListener("click", () => this.handlers.onGoTo(cell));
      return row;
    }));
    if (!mine.length) this.inHand.append(el("p", "empty", "No formations in the field."));
  }

  /** What a formation is doing, and the ground it is doing it on. */
  private doingText(match: Match, binding: Binding) {
    const doing = ORDER_DOING[binding.order.kind];
    const goal = binding.order.cells[0];
    if (!goal || binding.order.kind === "reserve") return doing;
    const post = match.structuresOf("player").find((structure) =>
      structure.cell.x === goal.x && structure.cell.y === goal.y);
    return `${doing} ${post ? post.name : `${goal.x},${goal.y}`}`;
  }

  // -- the standing list ----------------------------------------------------

  private row(match: Match, rule: Rule) {
    const card = el("article", "rule");
    card.dataset.rule = rule.id;
    if (!rule.enabled) card.dataset.off = "1";

    const open = el("button", "rule-open");
    open.append(el("span", "rule-text", orderText(rule, match.naming())));
    if (NEEDS_PLACE(rule.action) && !rule.place) {
      open.append(el("span", "rule-gap", "no ground named"));
    }
    open.title = watchText(rule, match.naming());
    open.addEventListener("click", () => this.reopen(rule.id));
    card.append(open);

    const tools = el("div", "rule-tools");
    const gear = el("button", "icon");
    gear.innerHTML = GEAR;
    gear.title = "Amend this order";
    gear.addEventListener("click", () => this.reopen(rule.id));
    const toggle = el("button", "icon", rule.enabled ? "◉" : "○");
    toggle.title = rule.enabled ? "In force — click to stand it down" : "Stood down — click to put it in force";
    toggle.addEventListener("click", () => this.handlers.onChange(rule.id, { enabled: !rule.enabled }));
    const drop = el("button", "icon danger", "×");
    drop.title = "Strike this order";
    drop.addEventListener("click", () => this.handlers.onRemove(rule.id));
    tools.append(gear, toggle, drop);

    card.append(tools);
    card.addEventListener("pointerenter", () => this.handlers.onFocus(rule));
    return card;
  }

  // -- the pickers ----------------------------------------------------------

  private formations(match: Match) {
    return [...match.bindings.values()]
      .filter((binding) => binding.side === "player" && match.bindingUnits(binding).length > 0);
  }

  private armOf(match: Match, actor: OrderActor): UnitType | null {
    if (actor.kind !== "binding") return null;
    const binding = match.bindingByName(actor.ref);
    return binding ? match.bindingUnits(binding)[0]?.type ?? null : null;
  }

  private watchOptions(match: Match): Option[] {
    return [
      ...this.formations(match).map((binding) => [`b:${binding.name}`, binding.name] as Option),
      ...match.structuresOf("player").map((structure) => [`s:${structure.id}`, structure.name] as Option),
      ["chest", "the war chest"],
    ];
  }

  private actorOptions(match: Match): Option[] {
    return [
      ...this.formations(match).map((binding) => [`b:${binding.name}`, binding.name] as Option),
      ...match.structuresOf("player").map((structure) => [`s:${structure.id}`, structure.name] as Option),
    ];
  }

  private placeOptions(match: Match, rule: Rule): Option[] {
    const options: Option[] = [];
    if (HAS_ATTACKER(rule.trigger)) {
      options.push(["attacker", match.naming().place({ kind: "attacker" }, rule.trigger)]);
    }
    for (const binding of this.formations(match)) options.push([`b:${binding.name}`, binding.name]);
    for (const structure of match.structuresOf("player")) options.push([`s:${structure.id}`, structure.name]);
    if (rule.place?.kind === "point") {
      options.push(["point", `${rule.place.cell.x},${rule.place.cell.y}`]);
    }
    options.push(["pick", "mark it on the map…"]);
    return options;
  }

  /**
   * Keep the card honest.
   *
   * Changing one part of an order can leave another part impossible -- a base
   * that was told to charge, a watch that no longer sees an enemy for "the
   * attacker" to mean -- so every change is repaired before it is applied.
   */
  private repair(match: Match, rule: Rule, patch: Partial<Rule>): Partial<Rule> {
    const next: Rule = { ...rule, ...patch };
    const fixed: Partial<Rule> = { ...patch };

    const triggers = TRIGGERS_FOR[next.watch.kind];
    if (!triggers.includes(next.trigger)) {
      next.trigger = triggers[0] ?? "under_fire";
      fixed.trigger = next.trigger;
    }
    const actions = ACTIONS_FOR(next.actor.kind, this.armOf(match, next.actor));
    if (!actions.includes(next.action)) {
      next.action = actions[0] ?? "hold";
      fixed.action = next.action;
    }
    if (!NEEDS_PLACE(next.action) && next.place) fixed.place = null;
    if (next.place?.kind === "attacker" && !HAS_ATTACKER(next.trigger)) fixed.place = null;
    if (next.trigger === "supply_above" && (next.threshold < 50 || patch.trigger === "supply_above")) {
      fixed.threshold = Math.max(100, Math.round(next.threshold));
    }
    if (next.trigger === "weakened" && next.threshold > 95) fixed.threshold = 40;
    return fixed;
  }

  private set(match: Match, rule: Rule, patch: Partial<Rule>) {
    this.handlers.onChange(rule.id, this.repair(match, rule, patch));
  }

  // -- the order card -------------------------------------------------------

  private paintCard(match: Match, rule: Rule) {
    const name = match.naming();
    this.sheet.replaceChildren();

    const head = el("header", "panel-head sheet-head");
    head.append(el("h2", undefined, `Orders to ${name.actor(rule.actor) || "—"}`));
    const shut = el("button", "icon", "×");
    shut.title = "Close";
    shut.addEventListener("click", () => this.close());
    head.append(shut);
    this.sheet.append(head);

    // The order as it will read on the field. It is written by the pickers
    // below, never typed into.
    this.sheet.append(el("p", "sheet-reads", describeRule(rule, name)));

    const rows = el("div", "sheet-rows");
    const band = (title: string) => rows.append(el("h3", "order-band", title));
    const row = (...controls: HTMLElement[]) => {
      const wrap = el("div", "sheet-row");
      wrap.append(...controls);
      rows.append(wrap);
    };

    band("Watch");
    const watchPick = dropdown(this.watchOptions(match), watchKey(rule.watch), (value) => {
      const watch: Watched = value === "chest" ? { kind: "chest" } : refOf(value) ?? rule.watch;
      this.set(match, rule, { watch });
    });
    const triggers = TRIGGERS_FOR[rule.watch.kind];
    const triggerPick = dropdown(
      triggers.map((trigger) => [trigger, TRIGGER_TEXT[trigger]] as Option),
      rule.trigger,
      (value) => this.set(match, rule, { trigger: value as Trigger }),
    );
    if (rule.trigger === "weakened") {
      row(watchPick, triggerPick, this.number(Math.round(rule.threshold), 5, 95,
        (value) => this.set(match, rule, { threshold: value })), el("span", "kw", "% of strength"));
    } else if (rule.trigger === "supply_above") {
      row(watchPick, triggerPick, this.number(Math.round(rule.threshold), 100, 6000,
        (value) => this.set(match, rule, { threshold: value })), el("span", "kw", "crates"));
    } else {
      row(watchPick, triggerPick);
    }

    band("Order");
    const actorPick = dropdown(this.actorOptions(match), actorKey(rule.actor), (value) => {
      const actor = refOf(value);
      if (actor) this.set(match, rule, { actor });
    });
    const actions = ACTIONS_FOR(rule.actor.kind, this.armOf(match, rule.actor));
    const actionPick = dropdown(
      actions.map((action) => [action, ACTION_ORDER[action]] as Option),
      rule.action,
      (value) => this.set(match, rule, { action: value as ActionKind }),
    );
    row(actorPick, actionPick);

    if (rule.action === "recruit") {
      row(
        this.number(rule.count, 1, 60, (value) => this.set(match, rule, { count: value })),
        dropdown(UNIT_TYPES.map((type) => [type, type] as Option), rule.unitType,
          (value) => this.set(match, rule, { unitType: value as UnitType })),
      );
    } else if (NEEDS_PLACE(rule.action)) {
      row(el("span", "kw", "on"), dropdown(
        this.placeOptions(match, rule),
        placeKey(rule.place),
        (value) => {
          if (value === "pick") {
            this.scrim.dataset.on = "0";
            closeMenus();
            return this.handlers.onPickPlace(rule.id);
          }
          if (value === "attacker") return this.set(match, rule, { place: { kind: "attacker" } });
          if (value === "point") return;
          const place = refOf(value);
          if (place) this.set(match, rule, { place });
        },
      ));
    }

    const feet = el("div", "sheet-feet");
    const once = el("label", "check");
    const box = el("input") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = rule.once;
    box.addEventListener("change", () => this.handlers.onChange(rule.id, { once: box.checked }));
    once.append(box, el("span", undefined, "once only"));
    feet.append(once, el("span", "kw", "then wait"),
      this.number(Math.round(rule.cooldownS), 0, 300, (value) => this.handlers.onChange(rule.id, { cooldownS: value })),
      el("span", "kw", "s"));
    const done = el("button", "begin", "Done");
    done.addEventListener("click", () => this.close());
    feet.append(done);

    this.sheet.append(rows, feet);
  }

  private number(value: number, min: number, max: number, onSet: (value: number) => void) {
    const input = el("input", "num") as HTMLInputElement;
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.addEventListener("change", () => onSet(Number(input.value)));
    return input;
  }
}
