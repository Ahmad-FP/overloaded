import { isWork, ORDERS, PRIORITIES, SHAPES, UNIT_TYPES, WORK_KINDS, WORKS, type WorkKind } from "../domain/constants";
import { tradeRate, unitCost, type Match } from "../domain/match";
import { musketRange } from "../domain/terrain";
import type {
  Alert, Cell, OrderKind, Priority, ProductionOrder, Quality, Rule, Shape, Structure, UnitType,
} from "../domain/types";
import { ORDER_KEY, ORDER_LABEL } from "./keys";
import { panel } from "./panel";
import { dropdown, type Option } from "./pick";
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
  beginBuild: (kind: WorkKind) => void;
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
  pickWork: (id: string | null) => void;
  addRule: (seed: Partial<Rule>) => void;
  changeRule: (id: string, patch: Partial<Rule>) => void;
  removeRule: (id: string) => void;
  /** Send the player to the map to mark the ground an order aims at. */
  pickPlace: (id: string) => void;
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
const MEN = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 20.4c0-4 3.1-6.4 7-6.4s7 2.4 7 6.4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

const time = (seconds: number) => {
  const m = Math.floor(Math.max(0, seconds) / 60);
  const s = Math.floor(Math.max(0, seconds) % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

export class Hud {
  readonly root: HTMLElement;
  readonly book: RuleBook;
  private supplyValue = el("strong", "num", "0");
  private incomeValue = el("span", "sub", "+0/min");
  private depotValue = el("strong", "num", "0");
  private depotWord = el("span", "sub", "depots");
  private clockValue = el("strong", "num", "0:00");
  private pauseButton = el("button", "tool", "Pause");
  private speedButton = el("button", "tool", "1×");
  private muteButton = el("button", "tool", "Sound");
  private baseList = el("div", "base-list");
  private workButtons = new Map<WorkKind, HTMLButtonElement>();
  private feed = el("div", "feed");
  private tray = el("div", "tray");
  private traySignature = "";
  private baseSignature = "";
  private feedSignature = "";
  private buildButton = el("button", "primary", "Build");
  private mineBar = el("i", "mine");
  private theirsBar = el("i", "theirs");
  private mineCount = el("span", "tally mine", "0");
  private theirsCount = el("span", "tally theirs", "0");
  private mapSlot = el("div", "map-slot");
  private rosterSlot = el("div", "roster-slot");
  private trayStats = el("div", "tray-stats");
  private worksMenu = el("div", "works-menu");
  /** What the selected work would raise, kept across repaints. */
  private buyType: UnitType = "infantry";
  private buyCount = 16;

  constructor(host: HTMLElement, private handlers: HudHandlers) {
    this.root = el("div", "hud");

    const top = el("div", "topbar");
    // Each readout sits behind a struck circular badge rather than a bare
    // glyph -- the one piece of Civilization's plate language the panels were
    // missing entirely.
    const badge = (mark: HTMLSpanElement) => {
      const ring = el("span", "badge");
      ring.append(mark);
      return ring;
    };
    const supply = el("div", "res");
    supply.append(badge(svg(CRATE)), this.supplyValue, this.incomeValue);
    supply.title = "Supply crates, and what the connected network is bringing in each minute.";
    const depots = el("div", "res");
    depots.append(badge(svg(FLAG)), this.depotValue, this.depotWord);
    depots.title = "Depots you hold. The tiebreak when the clock runs out.";
    const clock = el("div", "res");
    clock.append(badge(svg(CLOCK)), this.clockValue);
    clock.title = "Time left in the match.";

    /**
     * The returns.
     *
     * Your own strength is known exactly; the enemy's is only ever what has
     * been seen, and the bar says so rather than quietly leaking the fog.
     */
    const standing = el("div", "standing");
    const scale = el("div", "scale");
    scale.append(this.mineBar, this.theirsBar);
    const tally = el("div", "tallies");
    tally.append(this.mineCount, el("span", "sub", "in hand · sighted"), this.theirsCount);
    standing.append(badge(svg(MEN)), el("div", "scale-wrap"));
    const wrap = standing.querySelector(".scale-wrap");
    wrap?.append(scale, tally);
    standing.title = "Men you have in the field, against the enemy strength you have actually seen.";

    const tools = el("div", "tools");
    this.pauseButton.addEventListener("click", () => handlers.togglePause());
    this.speedButton.addEventListener("click", () => this.cycleSpeed());
    this.muteButton.addEventListener("click", () => handlers.toggleMute());
    tools.append(this.pauseButton, this.speedButton, this.muteButton);
    top.append(supply, depots, clock, standing, tools);
    this.root.append(top);

    const left = el("aside", "rail left");
    // The works panel is a list of what you hold, nothing more. The five kinds
    // of work, their prices and the ground each one wants are a wall of text,
    // so they live behind Build; what a particular work can do for you lives
    // in the tray, where the rest of the detail already is.
    const works = panel("Works", "works", "left");
    this.buildWorksMenu(handlers);
    this.buildButton.addEventListener("click", () => {
      const open = this.worksMenu.dataset.open !== "1";
      this.worksMenu.dataset.open = open ? "1" : "0";
    });
    works.tools.append(this.buildButton);
    works.body.append(this.worksMenu, this.baseList);
    left.append(works.root, this.mapSlot);
    this.root.append(left);

    const right = el("aside", "rail right");
    this.book = new RuleBook({
      onAdd: (seed) => handlers.addRule(seed),
      onChange: (id, patch) => handlers.changeRule(id, patch),
      onRemove: (id) => handlers.removeRule(id),
      onFocus: () => undefined,
      onPickPlace: (id) => handlers.pickPlace(id),
      onGoTo: (cell) => handlers.focus(cell),
    });
    const dispatches = panel("Dispatches", "dispatches", "right");
    dispatches.body.append(this.feed);
    right.append(this.book.root, dispatches.root);
    this.root.append(right);

    this.root.append(this.rosterSlot, this.tray);
    host.append(this.root);
  }

  /** The two panels that own their own canvases live outside this file. */
  attach(minimap: HTMLElement, roster: HTMLElement) {
    this.mapSlot.replaceChildren(minimap);
    this.rosterSlot.replaceChildren(roster);
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

  setBuilding(kind: WorkKind | null) {
    if (kind) this.worksMenu.dataset.open = "1";
    this.buildButton.dataset.armed = kind ? "1" : "0";
    this.buildButton.textContent = kind ? `Site the ${WORKS[kind].name.toLowerCase()} · Esc` : "Build";
    for (const [key, node] of this.workButtons) {
      node.dataset.on = key === kind ? "1" : "0";
    }
  }

  /**
   * The works menu.
   *
   * Each entry carries its cost and the ground it wants, because where a work
   * goes is the decision -- Civilization VI's districts put the choice in the
   * map rather than the menu, and a barracks that has to back onto a road is
   * only interesting if the player is told so before they place it.
   */
  private buildWorksMenu(handlers: HudHandlers) {
    const menu = this.worksMenu;
    menu.dataset.open = "0";
    for (const kind of WORK_KINDS) {
      const work = WORKS[kind];
      const button = el("button", "work-btn");
      button.dataset.on = "0";
      const top = el("span", "work-top");
      top.append(el("strong", undefined, work.name));
      const cost = el("span", "work-cost");
      cost.append(svg(CRATE), el("span", undefined, String(work.cost)));
      top.append(cost);
      button.append(top);
      button.append(el("span", "work-wants", work.wants.label));
      button.title = `${work.blurb} ${work.wants.label}.`;
      button.addEventListener("click", () => handlers.beginBuild(kind));
      this.workButtons.set(kind, button);
      menu.append(button);
    }
    return menu;
  }

  update(match: Match, selection: Set<string>, workId: string | null = null) {
    this.supplyValue.textContent = Math.floor(match.supply.player).toLocaleString();
    this.incomeValue.textContent = `+${match.income.player}/min`;
    this.incomeValue.dataset.cut = match.income.player <= 90 ? "1" : "0";
    const depotsHeld = match.held("player");
    this.depotValue.textContent = String(depotsHeld);
    this.depotWord.textContent = depotsHeld === 1 ? "depot" : "depots";
    this.clockValue.textContent = time(match.settings.timeLimitS - match.clock);
    this.pauseButton.textContent = match.paused ? "Resume" : "Pause";
    this.pauseButton.dataset.off = match.paused ? "1" : "0";
    this.updateStanding(match);
    this.updateBases(match, workId);
    this.updateFeed(match);
    this.updateTray(match, selection, workId);
    this.book.update(match);
  }

  private updateStanding(match: Match) {
    const mine = match.living("player").length;
    const seen = [...match.units.values()].filter((unit) =>
      unit.alive && unit.side === "enemy" && match.visibleTo("player", unit).seen).length;
    const total = Math.max(1, mine + seen);
    this.mineBar.style.width = `${(mine / total) * 100}%`;
    this.theirsBar.style.width = `${(seen / total) * 100}%`;
    this.mineCount.textContent = String(mine);
    this.theirsCount.textContent = String(seen);
  }

  private updateBases(match: Match, workId: string | null) {
    const works = match.structuresOf("player").sort((a, b) => (a.kind === "main" ? -1 : 1) - (b.kind === "main" ? -1 : 1));
    const queued = match.production.filter((order) => order.side === "player");
    const signature = works.map((w) => `${w.id}${w.connected}${Math.round(w.hp)}${w.build.toFixed(2)}`).join("|")
      + "#" + queued.map((q) => `${q.id}${Math.ceil(q.leftS)}`).join("|") + "#" + workId;
    if (signature === this.baseSignature) return;
    this.baseSignature = signature;
    this.baseList.replaceChildren(...works.map((structure) => {
      const row = el("button", "work-row");
      row.dataset.kind = structure.kind;
      row.dataset.on = structure.id === workId ? "1" : "0";
      if (!structure.connected) row.dataset.cut = "1";

      const head = el("div", "work-row-head");
      head.append(el("strong", undefined, structure.name));
      head.append(el("span", "tag", structure.build < 1
        ? `building ${Math.round(structure.build * 100)}%`
        : structure.connected ? (structure.yield ? `+${structure.yield}` : "—") : "cut off"));
      row.append(head);

      const bar = el("div", "hpbar");
      const fill = el("i");
      fill.style.width = `${Math.max(0, Math.min(100, (structure.hp / structure.maxHp) * 100)).toFixed(1)}%`;
      bar.append(fill);
      row.append(bar);

      const making = queued.filter((order) => order.structureId === structure.id)[0];
      if (making) row.append(el("span", "work-making", `${making.count} ${ARM[making.type]} · ${Math.ceil(making.leftS)}s`));

      row.addEventListener("click", () => {
        this.handlers.pickWork(structure.id === workId ? null : structure.id);
        this.handlers.focus(structure.cell);
      });
      return row;
    }));
    if (!works.length) this.baseList.append(el("p", "empty", "Nothing standing."));
  }

  private updateFeed(match: Match) {
    const alerts = match.alerts.filter((alert) => alert.side === "player").slice(0, 10);
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

  private updateTray(match: Match, selection: Set<string>, workId: string | null) {
    const names = [...selection].filter((name) => match.bindingByName(name));
    const first = names[0] ? match.bindingByName(names[0]) : undefined;
    const work = !first && workId ? match.structures.get(workId) : undefined;
    const making = work ? match.production.filter((order) => order.structureId === work.id) : [];
    const signature = `${names.join(",")}|${first?.order.kind}|${first?.shape}|${first?.order.priority}|${first?.order.holdFire}|${first?.order.load}|${Math.round(first?.order.engageRange ?? 0)}`
      + `|${work?.id}${work?.connected}${Math.round(work?.hp ?? 0)}${work?.build.toFixed(2)}|${this.buyType}${this.buyCount}|${Math.floor(match.supply.player / 20)}`
      + `|${making.map((order) => `${order.id}${Math.ceil(order.leftS)}`).join(",")}`;
    if (signature === this.traySignature) return;
    this.traySignature = signature;
    this.tray.replaceChildren();
    if (work) {
      this.tray.dataset.empty = "0";
      this.workTray(match, work, making);
      return;
    }
    if (!first) {
      this.tray.dataset.empty = "1";
      // A state, not a lecture: the tutorial teaches selection once and retires.
      this.tray.append(el("p", "hint", "No formation selected"));
      return;
    }
    this.tray.dataset.empty = "0";

    const who = el("div", "tray-who");
    who.append(el("h3", undefined, names.join(" · ")));
    const men = match.bindingUnits(first);
    const strength = men.length;
    who.append(el("span", "sub", `${strength} of ${first.establishment} · ${first.order.kind.replace("_", " ")}`));
    const orders = el("button", "ghost", "Standing order");
    orders.title = `Write an order ${first.name} carries out on its own`;
    orders.addEventListener("click", () => this.book.ordersFor(first));
    who.append(orders);
    this.tray.append(who);

    // What the formation actually is, in numbers. A player deciding whether to
    // push a battery forward wants its reach, not an adjective.
    const lead = men[0];
    this.trayStats.replaceChildren();
    if (lead) {
      const reach = lead.type === "artillery" ? 380 : Math.round(musketRange(lead.powder));
      const pips = (grade: number) => {
        const row = el("strong", "pips");
        for (let step = 1; step <= 3; step += 1) {
          const pip = el("i");
          pip.dataset.lit = step <= grade ? "1" : "0";
          row.append(pip);
        }
        return row;
      };
      for (const [label, value] of [
        ["Arm", el("strong", undefined, ARM[lead.type])],
        ["Reach", el("strong", undefined, `${reach} m`)],
        ["Powder", pips(lead.powder)],
        ["Steel", pips(lead.weapon)],
      ] as ReadonlyArray<readonly [string, HTMLElement]>) {
        const cell = el("span", "stat");
        cell.append(el("span", "stat-label", label), value);
        this.trayStats.append(cell);
      }
      this.tray.append(this.trayStats);
    }

    const verbs = el("div", "verbs");
    for (const order of ORDERS) {
      const button = el("button", "verb", ORDER_LABEL[order]);
      // Advertise the shortcut on the control itself rather than expecting it
      // to be memorised from a wall of text.
      button.append(el("span", "key", ORDER_KEY[order]));
      button.title = `${ORDER_LABEL[order]} (${ORDER_KEY[order]})`;
      button.dataset.on = first.order.kind === order ? "1" : "0";
      button.addEventListener("click", () => this.handlers.order(order));
      verbs.append(button);
    }
    this.tray.append(verbs);

    const knobs = el("div", "knobs");
    knobs.append(this.pick("Formation", SHAPES.map((shape) => [shape, shape] as Option), first.shape, (value) => this.handlers.setShape(value as Shape)));
    knobs.append(this.pick("Target", PRIORITIES.map((priority) => [priority, priority] as Option), first.order.priority, (value) => this.handlers.setPriority(value as Priority)));
    knobs.append(this.pick("Load", [["round", "round shot"], ["canister", "canister"]] as Option[], first.order.load, (value) => this.handlers.setLoad(value as "round" | "canister")));

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

  /**
   * The selected work.
   *
   * Clicking a base on the map or in the list brings it here rather than
   * opening a menu of its own: the tray is already where the detail of the
   * selected thing lives, and a base is a thing you select.
   */
  private workTray(match: Match, work: Structure, making: ProductionOrder[]) {
    const who = el("div", "tray-who");
    who.append(el("h3", undefined, work.name));
    const kind = isWork(work.kind) ? WORKS[work.kind as WorkKind] : null;
    const state = work.build < 1
      ? `building ${Math.round(work.build * 100)}%`
      : work.connected ? "in supply" : "cut off";
    who.append(el("span", "sub", `${kind?.name ?? (work.kind === "main" ? "Headquarters" : "Depot")} · ${state}`));
    if (work.kind !== "depot" && work.build >= 1) {
      const orders = el("button", "ghost", "Standing order");
      orders.title = `Write an order ${work.name} carries out on its own`;
      orders.addEventListener("click", () => this.book.ordersForBase(work.id));
      who.append(orders);
    }
    this.tray.append(who);

    this.trayStats.replaceChildren();
    for (const [label, value] of [
      ["Yield", work.connected && work.build >= 1 && work.yield ? `+${work.yield}/min` : "—"],
      ["Standing", `${Math.round(work.hp)} of ${Math.round(work.maxHp)}`],
      ["Ground", kind ? (work.sited ? kind.wants.label : "no bonus here") : "—"],
    ] as ReadonlyArray<readonly [string, string]>) {
      const cell = el("span", "stat");
      cell.append(el("span", "stat-label", label), el("strong", undefined, value));
      this.trayStats.append(cell);
    }
    this.tray.append(this.trayStats);

    if (work.kind === "depot" || work.build < 1) {
      this.tray.append(el("p", "hint", work.build < 1
        ? "Still being raised."
        : "A depot pays while it is connected. It cannot raise men."));
      return;
    }

    // Raise as many as you want, not one of three preset blocks.
    const line = el("div", "raise");
    line.append(dropdown(
      UNIT_TYPES.map((type) => [type, ARM[type]] as Option),
      this.buyType,
      (value) => { this.buyType = value as UnitType; this.traySignature = ""; },
    ));

    const step = (by: number) => {
      const button = el("button", "step", by > 0 ? "+" : "−");
      button.addEventListener("click", () => {
        this.buyCount = Math.max(1, Math.min(120, this.buyCount + by));
        count.value = String(this.buyCount);
        this.traySignature = "";
      });
      return button;
    };
    const count = el("input", "num") as HTMLInputElement;
    count.type = "number";
    count.min = "1";
    count.max = "120";
    count.value = String(this.buyCount);
    count.addEventListener("change", () => {
      this.buyCount = Math.max(1, Math.min(120, Math.round(Number(count.value) || 1)));
      count.value = String(this.buyCount);
      this.traySignature = "";
    });
    line.append(step(-1), count, step(1));

    const bill = Math.round(unitCost(this.buyType, 2) * this.buyCount * tradeRate(work, this.buyType));
    const cost = el("span", "buy-cost");
    cost.append(svg(CRATE), el("span", undefined, String(bill)));
    line.append(cost);

    const go = el("button", "primary", "Raise");
    go.disabled = match.supply.player < bill || !work.connected;
    go.addEventListener("click", () => this.handlers.recruit(work.id, this.buyType, this.buyCount, 2));
    line.append(go);
    this.tray.append(line);

    if (tradeRate(work, this.buyType) < 1) {
      const off = Math.round((1 - tradeRate(work, this.buyType)) * 100);
      this.tray.append(el("p", "hint", `${work.name} raises ${ARM[this.buyType].toLowerCase()} ${off}% cheaper and faster.`));
    }

    if (making.length) {
      const queue = el("div", "queue");
      for (const order of making) {
        const row = el("div", "queue-row");
        row.append(el("span", undefined, `${order.count} ${ARM[order.type]}`));
        const meter = el("div", "meter");
        const fillNode = el("i");
        fillNode.style.width = `${(1 - order.leftS / Math.max(0.1, order.totalS)) * 100}%`;
        meter.append(fillNode);
        row.append(meter, el("span", "sub", `${Math.ceil(order.leftS)}s`));
        queue.append(row);
      }
      this.tray.append(queue);
    }
  }

  private pick(label: string, options: Option[], value: string, onPick: (value: string) => void) {
    const wrap = el("div", "knob");
    wrap.append(el("span", "knob-label", label));
    wrap.append(dropdown(options, value, onPick));
    return wrap;
  }
}
