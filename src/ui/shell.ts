import { MAP_IDS } from "../domain/constants";
import { MAPS } from "../domain/maps";
import { mapThumb } from "./mapThumb";
import type { Match } from "../domain/match";
import type { MapId } from "../domain/types";

/**
 * The two screens that are not the battle: the field order you sign before it
 * starts, and the dispatch that closes it.
 */

export type ShellHandlers = {
  setMap: (id: MapId) => void;
  setMinutes: (minutes: number) => void;
  setDifficulty: (level: 1 | 2 | 3) => void;
  setTips: (on: boolean) => void;
  begin: () => void;
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
  private timeRow = el("div", "choices tight");
  private diffRow = el("div", "choices tight");
  private tipsRow = el("div", "choices tight");
  private tipsOn = true;
  private status = el("p", "mcp");
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
    card.append(head);

    card.append(this.field("Map", this.mapRow));
    card.append(this.field("Length", this.timeRow));
    card.append(this.field("Difficulty", this.diffRow));
    card.append(this.field("Tutorial", this.tipsRow));

    const go = el("button", "begin", "Start");
    go.addEventListener("click", () => this.handlers.begin());
    card.append(go);
    card.append(this.status);
    this.boot.append(card);
    return this.boot;
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
  paint(match: Match, webmcp: { registered: boolean; count: number }) {
    this.boot.dataset.on = match.phase === "boot" ? "1" : "0";
    this.result.dataset.on = match.phase === "result" ? "1" : "0";
    this.root.dataset.on = match.phase === "battle" ? "0" : "1";

    const sig = `${match.settings.mapId}|${match.settings.timeLimitS}|${match.settings.difficulty}|${this.tipsOn}`;
    if (sig !== this.mapSig) {
      this.mapSig = sig;
      this.paintChoices(match);
    }
    this.status.textContent = webmcp.registered
      ? `Agent tools available (${webmcp.count})`
      : "";
    this.status.dataset.on = webmcp.registered ? "1" : "0";

    if (match.phase === "result") this.paintResult(match);
  }

  private paintChoices(match: Match) {
    // Pick a map by looking at it, not by reading what it is meant to teach.
    this.mapRow.replaceChildren(...MAP_IDS.map((id) => {
      const map = MAPS[id];
      const button = el("button", "choice map-choice");
      button.dataset.on = match.settings.mapId === id ? "1" : "0";
      const frame = el("span", "thumb");
      frame.append(mapThumb(map, 260));
      button.append(frame);
      button.append(el("strong", undefined, map.name));
      button.addEventListener("click", () => this.handlers.setMap(id));
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

    this.tipsRow.replaceChildren(...([["On", true], ["Off", false]] as const).map(([name, on]) => {
      const button = el("button", "choice", name);
      button.dataset.on = this.tipsOn === on ? "1" : "0";
      button.addEventListener("click", () => this.handlers.setTips(on));
      return button;
    }));
  }

  /** Mirror the coach's own state, which outlives a single match. */
  setTips(on: boolean) {
    this.tipsOn = on;
    this.mapSig = "";
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
