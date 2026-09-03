import { ACTIONS, UNIT_TYPES, WHERE } from "../domain/constants";
import type { Match } from "../domain/match";
import { ACTION_TEXT, EVENTS_FOR, EVENT_TEXT, WHERE_TEXT } from "../domain/rules";
import type { ActionKind, EventKind, Rule, RuleTarget, UnitType, WhereKind } from "../domain/types";

/**
 * The standing-orders book.
 *
 * Each rule is one sentence with its nouns and verbs swapped for chips, so it
 * always reads as English and can never be assembled into something the engine
 * cannot run. This is the surface an agent drives over WebMCP as well — the
 * tool schema and this panel are generated from the same vocabulary, so a rule
 * written by the player and one written by the agent are the same object.
 */

export type RuleBookHandlers = {
  onChange: (id: string, patch: Partial<Rule>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onFocus: (rule: Rule) => void;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const chip = (options: Array<[string, string]>, value: string, onPick: (value: string) => void) => {
  const select = el("select", "chip");
  for (const [key, label] of options) {
    const option = el("option");
    option.value = key;
    option.textContent = label;
    select.append(option);
  }
  select.value = value;
  select.addEventListener("change", () => onPick(select.value));
  return select;
};

const targetKey = (target: RuleTarget) => `${target.kind}:${target.ref ?? ""}`;
const parseTarget = (key: string): RuleTarget => {
  const [kind, ref] = key.split(":");
  return ref ? { kind: kind as RuleTarget["kind"], ref } : { kind: kind as RuleTarget["kind"] };
};

export class RuleBook {
  readonly root: HTMLElement;
  private list: HTMLElement;
  private signature = "";

  constructor(private handlers: RuleBookHandlers) {
    this.root = el("section", "panel book");
    const head = el("header", "panel-head");
    head.append(el("h2", undefined, "Standing orders"));
    const add = el("button", "ghost", "+ New line");
    add.addEventListener("click", () => handlers.onAdd());
    head.append(add);
    this.root.append(head);
    this.list = el("div", "book-list");
    this.root.append(this.list);
  }

  /**
   * Rebuild only when the shape of the book changes.
   *
   * A `<select>` that is re-created under an open dropdown closes it, so the
   * panel is keyed on everything the player can edit and left alone otherwise;
   * the live counters are patched in place.
   */
  update(match: Match) {
    const rules = match.rules.filter((rule) => rule.side === "player");
    const names = [...match.bindings.values()].filter((binding) => binding.side === "player").map((binding) => binding.name).join(",");
    const works = match.structuresOf("player").map((structure) => structure.id).join(",");
    const signature = `${names}|${works}|${rules.map((rule) =>
      `${rule.id}${rule.enabled}${targetKey(rule.subject)}${rule.event}${targetKey(rule.actor)}${rule.action}${rule.where}${rule.threshold}${rule.count}${rule.unitType}${rule.once}${rule.cooldownS}`).join(";")}`;
    if (signature !== this.signature) {
      this.signature = signature;
      this.list.replaceChildren(...rules.map((rule) => this.card(match, rule)));
      if (!rules.length) this.list.append(el("p", "empty", "No standing orders. The staff will wait to be told."));
    }
    for (const rule of rules) {
      const node = this.list.querySelector<HTMLElement>(`[data-rule="${rule.id}"] .rule-state`);
      if (!node) continue;
      node.textContent = rule.cooldownLeft > 0.4
        ? `resetting ${Math.ceil(rule.cooldownLeft)}s`
        : rule.fired
          ? `acted ${rule.fired}×`
          : "watching";
      node.dataset.hot = rule.cooldownLeft > 0.4 ? "1" : "0";
    }
  }

  private card(match: Match, rule: Rule) {
    const bindings = [...match.bindings.values()].filter((binding) => binding.side === "player");
    const works = match.structuresOf("player");
    const card = el("article", "rule");
    card.dataset.rule = rule.id;
    if (!rule.enabled) card.dataset.off = "1";

    const head = el("div", "rule-head");
    const name = el("input", "rule-name") as HTMLInputElement;
    name.value = rule.name;
    name.maxLength = 28;
    name.addEventListener("change", () => this.handlers.onChange(rule.id, { name: name.value.slice(0, 28) || "Standing order" }));
    head.append(name);

    const state = el("span", "rule-state", "watching");
    head.append(state);

    const toggle = el("button", "icon", rule.enabled ? "◉" : "○");
    toggle.title = rule.enabled ? "In force — click to stand down" : "Stood down — click to put in force";
    toggle.addEventListener("click", () => this.handlers.onChange(rule.id, { enabled: !rule.enabled }));
    head.append(toggle);

    const drop = el("button", "icon danger", "×");
    drop.title = "Strike this line from the book";
    drop.addEventListener("click", () => this.handlers.onRemove(rule.id));
    head.append(drop);
    card.append(head);

    const line = el("p", "rule-line");
    line.append(el("span", "kw", "When"));

    const subjectOptions: Array<[string, string]> = [
      ["any_binding:", "any formation"],
      ["any_structure:", "any base"],
      ...bindings.map((binding) => [`binding:${binding.name}`, binding.name] as [string, string]),
      ...works.map((structure) => [`structure:${structure.id}`, structure.name] as [string, string]),
    ];
    line.append(chip(subjectOptions, targetKey(rule.subject), (value) => {
      const subject = parseTarget(value);
      const kind = subject.kind === "any_structure" || subject.kind === "structure" ? "structure" : "binding";
      const allowed = EVENTS_FOR[kind];
      const patch: Partial<Rule> = { subject };
      if (!allowed.includes(rule.event)) patch.event = allowed[0];
      this.handlers.onChange(rule.id, patch);
    }));

    const subjectKind = rule.subject.kind === "any_structure" || rule.subject.kind === "structure" ? "structure" : "binding";
    line.append(chip(
      EVENTS_FOR[subjectKind].map((event) => [event, EVENT_TEXT[event]] as [string, string]),
      rule.event,
      (value) => this.handlers.onChange(rule.id, { event: value as EventKind }),
    ));

    if (rule.event === "weakened" || rule.event === "timer") {
      const number = el("input", "chip num") as HTMLInputElement;
      number.type = "number";
      number.min = rule.event === "timer" ? "5" : "5";
      number.max = rule.event === "timer" ? "600" : "95";
      number.value = String(Math.round(rule.threshold));
      number.addEventListener("change", () => this.handlers.onChange(rule.id, { threshold: Number(number.value) }));
      line.append(number, el("span", "kw", rule.event === "timer" ? "seconds" : "%"));
    }

    line.append(el("span", "kw arrow", "→"));

    const actorOptions: Array<[string, string]> = [
      ["self:", "it"],
      ["nearest_reserve:", "the nearest reserve"],
      ...bindings.map((binding) => [`binding:${binding.name}`, binding.name] as [string, string]),
      ...works.map((structure) => [`structure:${structure.id}`, structure.name] as [string, string]),
    ];
    line.append(chip(actorOptions, targetKey(rule.actor), (value) =>
      this.handlers.onChange(rule.id, { actor: parseTarget(value) })));

    line.append(chip(
      ACTIONS.map((action) => [action, ACTION_TEXT[action as ActionKind]] as [string, string]),
      rule.action,
      (value) => this.handlers.onChange(rule.id, { action: value as ActionKind }),
    ));

    if (rule.action === "recruit") {
      const number = el("input", "chip num") as HTMLInputElement;
      number.type = "number";
      number.min = "1";
      number.max = "60";
      number.value = String(rule.count);
      number.addEventListener("change", () => this.handlers.onChange(rule.id, { count: Number(number.value) }));
      line.append(number);
      line.append(chip(
        UNIT_TYPES.map((type) => [type, type] as [string, string]),
        rule.unitType,
        (value) => this.handlers.onChange(rule.id, { unitType: value as UnitType }),
      ));
    } else if (rule.action !== "alert_only") {
      line.append(el("span", "kw", "at"));
      line.append(chip(
        WHERE.map((where) => [where, WHERE_TEXT[where as WhereKind]] as [string, string]),
        rule.where,
        (value) => this.handlers.onChange(rule.id, { where: value as WhereKind }),
      ));
    }
    card.append(line);

    const foot = el("div", "rule-foot");
    const once = el("label", "check");
    const box = el("input") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = rule.once;
    box.addEventListener("change", () => this.handlers.onChange(rule.id, { once: box.checked }));
    once.append(box, el("span", undefined, "once only"));
    foot.append(once);

    const cool = el("label", "check");
    const cooldown = el("input", "num") as HTMLInputElement;
    cooldown.type = "number";
    cooldown.min = "0";
    cooldown.max = "300";
    cooldown.value = String(Math.round(rule.cooldownS));
    cooldown.addEventListener("change", () => this.handlers.onChange(rule.id, { cooldownS: Number(cooldown.value) }));
    cool.append(el("span", undefined, "wait"), cooldown, el("span", undefined, "s"));
    foot.append(cool);
    card.append(foot);

    card.addEventListener("pointerenter", () => this.handlers.onFocus(rule));
    return card;
  }
}
