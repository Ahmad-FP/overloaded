import { MAP_IDS } from "../domain/constants";
import { FIELD_SIZES, mapById } from "../domain/maps";
import { mapThumb } from "./mapThumb";
import type { Match } from "../domain/match";
import type { MapId, OrderKind } from "../domain/types";
import { CONTROL_KEYS, ORDER_KEY, ORDER_LABEL } from "./keys";

/**
 * The two screens that are not the battle: the field order you sign before it
 * starts, and the dispatch that closes it.
 */

export type ShellHandlers = {
  setMap: (id: MapId) => void;
  setArea: (area: number) => void;
  setMinutes: (minutes: number) => void;
  setDifficulty: (level: 1 | 2 | 3) => void;
  begin: () => void;
  beginTutorial: () => void;
  again: () => void;
};

const MINUTES = [10, 20, 35];
const DIFFICULTY: Array<[1 | 2 | 3, string]> = [[1, "Easy"], [2, "Medium"], [3, "Hard"]];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export class Shell {
  readonly root = el("div", "shell");
  readonly heroCanvas = el("canvas", "hero");
  private boot = el("div", "screen boot");
  private result = el("div", "screen result");
  private mapRow = el("div", "choices maps");
  private sizeRow = el("div", "choices tight");
  private timeRow = el("div", "choices tight");
  private diffRow = el("div", "choices tight");
  /** Which face of the title screen is showing. */
  private view: "menu" | "setup" | "tutorial" | "controls" = "menu";
  private bootBody = el("div", "boot-body");
  private resultTitle = el("h1");
  private resultLine = el("p", "verdict");
  private resultStats = el("dl", "stats");

  constructor(host: HTMLElement, private handlers: ShellHandlers) {
    this.root.append(this.buildBoot(), this.buildResult());
    host.append(this.root);
  }

  private buildBoot() {
    this.boot.append(this.heroCanvas);
    const card = el("div", "card");
    const head = el("header", "card-head");
    head.append(el("h1", "wordmark", "Overloaded"));
    card.append(head, this.bootBody);
    this.boot.append(card);
    this.paintBoot();
    return this.boot;
  }

  private show(view: Shell["view"]) {
    this.view = view;
    this.paintBoot();
  }

  private nav(label: string, note: string, go: () => void) {
    const button = el("button", "menu-item");
    button.append(el("strong", undefined, label));
    button.append(el("span", "menu-note", note));
    button.addEventListener("click", go);
    return button;
  }

  private back() {
    const button = el("button", "back", "Back");
    button.addEventListener("click", () => this.show("menu"));
    return button;
  }

  private paintBoot() {
    this.bootBody.replaceChildren();
    if (this.view === "menu") {
      const list = el("nav", "menu");
      list.append(this.nav("Create game", "Pick the field, the clock and the opposition.", () => this.show("setup")));
      list.append(this.nav("Tutorial", "Learn it on the field, one step at a time.", () => this.show("tutorial")));
      list.append(this.nav("Controls", "Mouse and keyboard.", () => this.show("controls")));
      this.bootBody.append(list);
      return;
    }

    if (this.view === "setup") {
      this.bootBody.append(this.field("Map", this.mapRow));
      this.bootBody.append(this.field("Field size", this.sizeRow));
      this.bootBody.append(this.field("Length", this.timeRow));
      this.bootBody.append(this.field("Difficulty", this.diffRow));
      const go = el("button", "begin", "Start");
      go.addEventListener("click", () => this.handlers.begin());
      const feet = el("div", "card-feet");
      feet.append(this.back(), go);
      this.bootBody.append(feet);
      return;
    }

    if (this.view === "tutorial") {
      this.bootBody.append(el("p", "lede",
        "A short guided battle. The field is easy, the clock is long, and a card "
        + "walks you through selecting a formation, sending it, raising more men, "
        + "taking a depot and writing your first standing order."));
      const go = el("button", "begin", "Begin");
      go.addEventListener("click", () => this.handlers.beginTutorial());
      const feet = el("div", "card-feet");
      feet.append(this.back(), go);
      this.bootBody.append(feet);
      return;
    }

    const keys = el("dl", "keys");
    for (const [order, key] of Object.entries(ORDER_KEY) as Array<[OrderKind, string]>) {
      keys.append(el("dt", undefined, key));
      keys.append(el("dd", undefined, ORDER_LABEL[order]));
    }
    for (const [key, what] of CONTROL_KEYS) {
      keys.append(el("dt", undefined, key));
      keys.append(el("dd", undefined, what));
    }
    this.bootBody.append(keys);
    const feet = el("div", "card-feet");
    feet.append(this.back());
    this.bootBody.append(feet);
  }

  private field(label: string, row: HTMLElement) {
    const wrap = el("section", "field");
    wrap.append(el("h2", undefined, label));
    wrap.append(row);
    return wrap;
  }

  private buildResult() {
    const card = el("div", "card narrow");
    card.append(this.resultTitle, this.resultLine, this.resultStats);
    const again = el("button", "begin", "Another field");
    again.addEventListener("click", () => this.handlers.again());
    card.append(again);
    this.result.append(card);
    return this.result;
  }

  private mapSig = "";
  paint(match: Match) {
    this.boot.dataset.on = match.phase === "boot" ? "1" : "0";
    this.result.dataset.on = match.phase === "result" ? "1" : "0";
    this.root.dataset.on = match.phase === "battle" ? "0" : "1";

    // Every setting the rows draw has to be in here. `mapArea` was not, so
    // picking a field size set it and never redrew the row -- and changing the
    // length repainted everything, which made the clock look like it was
    // controlling the sizes.
    const sig = `${match.settings.mapId}|${match.settings.mapArea}|${match.settings.timeLimitS}`
      + `|${match.settings.difficulty}|${this.view}`;
    if (sig !== this.mapSig) {
      this.mapSig = sig;
      this.paintChoices(match);
    }
    if (match.phase === "result") this.paintResult(match);
  }

  private paintChoices(match: Match) {
    // Pick a map by looking at it, not by reading what it is meant to teach.
    this.mapRow.replaceChildren(...MAP_IDS.map((id) => {
      // The thumbnail is always the design grid: the composition is the same
      // at every size, and building a grand field to make a stamp of it costs
      // a quarter of a million tiles for nothing.
      const map = mapById(id, 1);
      const button = el("button", "choice map-choice");
      button.dataset.on = match.settings.mapId === id ? "1" : "0";
      const frame = el("span", "thumb");
      frame.append(mapThumb(map, 260));
      button.append(frame);
      button.append(el("strong", undefined, map.name));
      button.addEventListener("click", () => this.handlers.setMap(id));
      return button;
    }));

    this.sizeRow.replaceChildren(...FIELD_SIZES.map((size) => {
      const button = el("button", "choice", size.name);
      button.dataset.on = match.settings.mapArea === size.area ? "1" : "0";
      button.title = size.blurb;
      button.append(el("span", "choice-note", `${size.area}× ground`));
      button.addEventListener("click", () => this.handlers.setArea(size.area));
      return button;
    }));

    this.timeRow.replaceChildren(...MINUTES.map((minutes) => {
      const button = el("button", "choice", `${minutes} min`);
      button.dataset.on = Math.round(match.settings.timeLimitS / 60) === minutes ? "1" : "0";
      button.addEventListener("click", () => this.handlers.setMinutes(minutes));
      return button;
    }));

    this.diffRow.replaceChildren(...DIFFICULTY.map(([level, name]) => {
      const button = el("button", "choice", name);
      button.dataset.on = match.settings.difficulty === level ? "1" : "0";
      button.addEventListener("click", () => this.handlers.setDifficulty(level));
      return button;
    }));

  }

  private paintResult(match: Match) {
    const won = match.result === "win";
    this.result.dataset.kind = match.result ?? "draw";
    this.resultTitle.textContent = won ? "The field is yours" : match.result === "lose" ? "The field is lost" : "Neither side gives way";
    this.resultLine.textContent = won
      ? "Their colours came down. The depots stay on your ledger."
      : match.result === "lose"
        ? "Your headquarters was overrun. What was left of the army is scattered."
        : "The clock ran out with both headquarters standing.";

    const fired = match.rules.reduce((total, rule) => total + rule.fired, 0);
    const rows: Array<[string, string]> = [
      ["Depots held", `${match.held("player")} of ${match.world.depotCells.length}`],
      ["Crates banked", Math.floor(match.supply.player).toLocaleString()],
      ["Standing orders", `${match.rules.filter((r) => r.side === "player").length} written`],
      ["Orders acted on", `${fired} time${fired === 1 ? "" : "s"}`],
      ["Still standing", `${match.living("player").length} against ${match.living("enemy").length}`],
      ["Length", `${Math.floor(match.clock / 60)}:${String(Math.floor(match.clock % 60)).padStart(2, "0")}`],
    ];
    this.resultStats.replaceChildren();
    for (const [label, value] of rows) {
      this.resultStats.append(el("dt", undefined, label), el("dd", undefined, value));
    }
  }
}
