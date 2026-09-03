import { FOB_COST, ORDERS, PRIORITIES, SHAPES, UNIT_TYPES } from "../domain/constants";
import { unitCost, type Match } from "../domain/match";
import type { Alert, Cell, OrderKind, Priority, Quality, Rule, Shape, Structure, UnitType } from "../domain/types";
import { RuleBook } from "./ruleBook";

/**
 * Everything around the board.
 *
 * Built once as a stable tree and patched in place each frame — a HUD that
 * re-renders itself cannot hold an open dropdown, a caret, or a scroll
 * position, and all three matter here because the standing-orders book is a
 * form the player edits mid-battle.
 */

/**
 * What each arm is called on screen. "Artillery" is a mass noun, so a count in
 * front of it reads wrong -- you raise one cannon, not one artillery.
 */
const ARM: Record<UnitType, string> = { infantry: "Infantry", cavalry: "Cavalry", artillery: "Cannon" };

export type HudHandlers = {
  recruit: (structureId: string, type: UnitType, count: number, grade: Quality) => void;
  beginBuild: () => void;
  order: (kind: OrderKind) => void;
  setShape: (shape: Shape) => void;
  setPriority: (priority: Priority) => void;
  setEngage: (metres: number) => void;
  setHoldFire: (hold: boolean) => void;
  setLoad: (load: "round" | "canister") => void;
  focus: (cell: Cell) => void;
  togglePause: () => void;
  setSpeed: (speed: number) => void;
  toggleMute: () => void;
  addRule: () => void;
  changeRule: (id: string, patch: Partial<Rule>) => void;
  removeRule: (id: string) => void;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const svg = (markup: string) => {
  const wrap = el("span", "ico");
  wrap.innerHTML = markup;
  return wrap;
};

/** The resource mark: a crate. It is never called anything else in the UI. */
const CRATE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.2 12 3l9 4.2v9.6L12 21l-9-4.2Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M3 7.2 12 11.4l9-4.2M12 11.4V21" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7.6 5 16.4 9.2" stroke="currentColor" stroke-width="1.2"/></svg>`;
const FLAG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V3m0 1.6 11 2.4-3 3.6 3 3.6-11 2.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
const CLOCK = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M12 7.4V12l3.2 2.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

const time = (seconds: number) => {
  const m = Math.floor(Math.max(0, seconds) / 60);
  const s = Math.floor(Math.max(0, seconds) % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

const ORDER_LABEL: Record<OrderKind, string> = {
  move: "March",
  hold: "Hold",
  attack_area: "Attack",
  bombard: "Bombard",
  charge: "Charge",
  retreat: "Fall back",
  reserve: "Reserve",
};

export class Hud {
  readonly root: HTMLElement;
  readonly book: RuleBook;
  private supplyValue = el("strong", "num", "0");
  private incomeValue = el("span", "sub", "+0/min");
  private depotValue = el("strong", "num", "0");
  private clockValue = el("strong", "num", "0:00");
  private pauseButton = el("button", "tool", "Pause");
  private speedButton = el("button", "tool", "1×");
  private muteButton = el("button", "tool", "Sound");
  private baseList = el("div", "base-list");
  private feed = el("div", "feed");
  private tray = el("div", "tray");
  private traySignature = "";
  private baseSignature = "";
  private feedSignature = "";
  private buildButton = el("button", "primary");

  constructor(host: HTMLElement, private handlers: HudHandlers) {
    this.root = el("div", "hud");

    const top = el("div", "topbar");
    const supply = el("div", "res");
    supply.append(svg(CRATE), this.supplyValue, this.incomeValue);
    supply.title = "Supply crates, and what the connected network is bringing in each minute.";
    const depots = el("div", "res");
    depots.append(svg(FLAG), this.depotValue, el("span", "sub", "depots"));
    depots.title = "Depots you hold. The tiebreak when the clock runs out.";
    const clock = el("div", "res");
    clock.append(svg(CLOCK), this.clockValue);

    const tools = el("div", "tools");
    this.pauseButton.addEventListener("click", () => handlers.togglePause());
    this.speedButton.addEventListener("click", () => this.cycleSpeed());
    this.muteButton.addEventListener("click", () => handlers.toggleMute());
    tools.append(this.pauseButton, this.speedButton, this.muteButton);
    top.append(supply, depots, clock, tools);
    this.root.append(top);

    const left = el("aside", "rail left");
    const bases = el("section", "panel");
    const basesHead = el("header", "panel-head");
    basesHead.append(el("h2", undefined, "Works"));
    this.buildButton.textContent = `Raise redoubt · ${FOB_COST}`;
    this.buildButton.addEventListener("click", () => handlers.beginBuild());
    basesHead.append(this.buildButton);
    bases.append(basesHead, this.baseList);
    left.append(bases);
    this.root.append(left);

    const right = el("aside", "rail right");
    this.book = new RuleBook({
      onAdd: () => handlers.addRule(),
      onChange: (id, patch) => handlers.changeRule(id, patch),
      onRemove: (id) => handlers.removeRule(id),
      onFocus: () => undefined,
    });
    const dispatches = el("section", "panel dispatches");
    const feedHead = el("header", "panel-head");
    feedHead.append(el("h2", undefined, "Dispatches"));
    dispatches.append(feedHead, this.feed);
    right.append(this.book.root, dispatches);
    this.root.append(right);

    this.root.append(this.tray);
    host.append(this.root);
  }

  private speed = 1;
  private cycleSpeed() {
    this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1;
    this.speedButton.textContent = `${this.speed}×`;
    this.handlers.setSpeed(this.speed);
  }

  setMuted(muted: boolean) {
    this.muteButton.textContent = muted ? "Muted" : "Sound";
    this.muteButton.dataset.off = muted ? "1" : "0";
  }

  setBuilding(active: boolean) {
    this.buildButton.dataset.armed = active ? "1" : "0";
    this.buildButton.textContent = active ? "Pick a site · Esc" : `Raise redoubt · ${FOB_COST}`;
  }

  update(match: Match, selection: Set<string>) {
    this.supplyValue.textContent = Math.floor(match.supply.player).toLocaleString();
    this.incomeValue.textContent = `+${match.income.player}/min`;
    this.incomeValue.dataset.cut = match.income.player <= 90 ? "1" : "0";
    this.depotValue.textContent = String(match.held("player"));
    this.clockValue.textContent = time(match.settings.timeLimitS - match.clock);
    this.pauseButton.textContent = match.paused ? "Resume" : "Pause";
    this.pauseButton.dataset.off = match.paused ? "1" : "0";
    this.updateBases(match);
    this.updateFeed(match);
    this.updateTray(match, selection);
    this.book.update(match);
  }

  private updateBases(match: Match) {
    const works = match.structuresOf("player").sort((a, b) => (a.kind === "main" ? -1 : 1) - (b.kind === "main" ? -1 : 1));
    const queued = match.production.filter((order) => order.side === "player");
    const signature = works.map((w) => `${w.id}${w.connected}${Math.round(w.hp)}${w.build.toFixed(2)}`).join("|")
      + "#" + queued.map((q) => `${q.id}${Math.ceil(q.leftS)}`).join("|");
    if (signature === this.baseSignature) return;
    this.baseSignature = signature;
    this.baseList.replaceChildren(...works.map((structure) => this.baseCard(match, structure, queued)));
    if (!works.length) this.baseList.append(el("p", "empty", "Nothing standing."));
  }

  private baseCard(match: Match, structure: Structure, queued: ReturnType<Match["production"]["filter"]>) {
    const card = el("article", "base");
    card.dataset.kind = structure.kind;
    if (!structure.connected) card.dataset.cut = "1";

    const head = el("div", "base-head");
    const name = el("button", "link", structure.name);
    name.addEventListener("click", () => this.handlers.focus(structure.cell));
    head.append(name);
    head.append(el("span", "tag", structure.build < 1
      ? `building ${Math.round(structure.build * 100)}%`
      : structure.connected ? `+${structure.yield}` : "cut off"));
    card.append(head);

    const bar = el("div", "hpbar");
    const fill = el("i");
    fill.style.width = `${Math.max(0, Math.min(100, (structure.hp / structure.maxHp) * 100)).toFixed(1)}%`;
    bar.append(fill);
    card.append(bar);

    if (structure.kind !== "depot" && structure.build >= 1) {
      const buy = el("div", "buy");
      for (const type of UNIT_TYPES) {
        const count = type === "artillery" ? 1 : type === "cavalry" ? 8 : 16;
        const price = unitCost(type, 2) * count;
        const button = el("button", "buy-btn");
        button.append(el("span", "buy-type", `${count} ${ARM[type]}`));
        const cost = el("span", "buy-cost");
        cost.append(svg(CRATE), el("span", undefined, String(price)));
        button.append(cost);
        button.disabled = match.supply.player < price || !structure.connected;
        button.addEventListener("click", () => this.handlers.recruit(structure.id, type, count, 2));
        buy.append(button);
      }
      card.append(buy);
    }

    const mine = queued.filter((order) => order.structureId === structure.id);
    if (mine.length) {
      const queue = el("div", "queue");
      for (const order of mine) {
        const row = el("div", "queue-row");
        row.append(el("span", undefined, `${order.count} ${ARM[order.type]}`));
        const meter = el("div", "meter");
        const fillNode = el("i");
        fillNode.style.width = `${(1 - order.leftS / Math.max(0.1, order.totalS)) * 100}%`;
        meter.append(fillNode);
        row.append(meter, el("span", "sub", `${Math.ceil(order.leftS)}s`));
        queue.append(row);
      }
      card.append(queue);
    }
    return card;
  }

  private updateFeed(match: Match) {
    const alerts = match.alerts.filter((alert) => alert.side === "player").slice(0, 14);
    const signature = alerts.map((alert) => alert.id).join(",");
    if (signature === this.feedSignature) return;
    this.feedSignature = signature;
    this.feed.replaceChildren(...alerts.map((alert) => this.dispatch(alert)));
    if (!alerts.length) this.feed.append(el("p", "empty", "The field is quiet."));
  }

  private dispatch(alert: Alert) {
    const row = el("article", "dispatch");
    row.dataset.answered = alert.ruleId ? "1" : "0";
    row.dataset.event = alert.event;
    const head = el("div", "dispatch-head");
    head.append(el("span", "stamp", time(alert.atS)));
    head.append(el("span", "who", alert.subject));
    row.append(head);
    row.append(el("p", "what", alert.text));
    if (alert.response) {
      const answer = el("p", "answer");
      answer.append(el("span", "rule-tag", alert.ruleName ?? "standing order"));
      answer.append(el("span", undefined, alert.response));
      row.append(answer);
    }
    row.addEventListener("click", () => this.handlers.focus(alert.cell));
    return row;
  }

  private updateTray(match: Match, selection: Set<string>) {
    const names = [...selection].filter((name) => match.bindingByName(name));
    const first = names[0] ? match.bindingByName(names[0]) : undefined;
    const signature = `${names.join(",")}|${first?.order.kind}|${first?.shape}|${first?.order.priority}|${first?.order.holdFire}|${first?.order.load}|${Math.round(first?.order.engageRange ?? 0)}`;
    if (signature === this.traySignature) return;
    this.traySignature = signature;
    this.tray.replaceChildren();
    if (!first) {
      this.tray.dataset.empty = "1";
      this.tray.append(el("p", "hint", "Click a formation's banner to select it. Drag to select several. Right-click the ground to send them."));
      return;
    }
    this.tray.dataset.empty = "0";

    const who = el("div", "tray-who");
    who.append(el("h3", undefined, names.join(" · ")));
    const strength = match.bindingUnits(first).length;
    who.append(el("span", "sub", `${strength} of ${first.establishment} · ${first.order.kind.replace("_", " ")}`));
    this.tray.append(who);

    const verbs = el("div", "verbs");
    for (const order of ORDERS) {
      const button = el("button", "verb", ORDER_LABEL[order]);
      button.dataset.on = first.order.kind === order ? "1" : "0";
      button.addEventListener("click", () => this.handlers.order(order));
      verbs.append(button);
    }
    this.tray.append(verbs);

    const knobs = el("div", "knobs");
    knobs.append(this.pick("Formation", SHAPES.map((shape) => [shape, shape]), first.shape, (value) => this.handlers.setShape(value as Shape)));
    knobs.append(this.pick("Target", PRIORITIES.map((priority) => [priority, priority]), first.order.priority, (value) => this.handlers.setPriority(value as Priority)));
    knobs.append(this.pick("Load", [["round", "round shot"], ["canister", "canister"]], first.order.load, (value) => this.handlers.setLoad(value as "round" | "canister")));

    const range = el("label", "knob");
    range.append(el("span", "knob-label", "Engage"));
    const slider = el("input") as HTMLInputElement;
    slider.type = "range";
    slider.min = "20";
    slider.max = "220";
    slider.step = "5";
    slider.value = String(Math.round(first.order.engageRange));
    const readout = el("span", "knob-value", `${Math.round(first.order.engageRange)} m`);
    slider.addEventListener("input", () => {
      readout.textContent = `${slider.value} m`;
      this.handlers.setEngage(Number(slider.value));
    });
    range.append(slider, readout);
    knobs.append(range);

    const hold = el("label", "knob check");
    const box = el("input") as HTMLInputElement;
    box.type = "checkbox";
    box.checked = first.order.holdFire;
    box.addEventListener("change", () => this.handlers.setHoldFire(box.checked));
    hold.append(box, el("span", undefined, "hold fire"));
    knobs.append(hold);
    this.tray.append(knobs);
  }

  private pick(label: string, options: Array<[string, string]>, value: string, onPick: (value: string) => void) {
    const wrap = el("label", "knob");
    wrap.append(el("span", "knob-label", label));
    const select = el("select");
    for (const [key, text] of options) {
      const option = el("option");
      option.value = key;
      option.textContent = text;
      select.append(option);
    }
    select.value = value;
    select.addEventListener("change", () => onPick(select.value));
    wrap.append(select);
    return wrap;
  }
}
