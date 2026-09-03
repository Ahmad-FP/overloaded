import type { Match } from "../domain/match";
import type { Binding, Cell, UnitType } from "../domain/types";
import { ORDER_DOING } from "./keys";

/**
 * The roster.
 *
 * Formations are the unit of command here, and until now the only way to find
 * one was to spot its banner on the ground. That does not survive a field this
 * size: by the second engagement the player has lost track of what they own.
 *
 * So every formation keeps a standing card -- what it is, how much of it is
 * left, and what it is doing this second. Click to take it, click again to go
 * to it. The card says out loud the two things worth interrupting for: it is
 * being shot at, and it is running.
 */

const ARM: Record<UnitType, string> = {
  infantry: "Foot",
  cavalry: "Horse",
  artillery: "Guns",
};

/** A mark per arm: colour alone does not survive a glance at this size. */
const MARK: Record<UnitType, string> = {
  infantry: "▮",
  cavalry: "▲",
  artillery: "●",
};

type Card = {
  node: HTMLButtonElement;
  mark: HTMLElement;
  fill: HTMLElement;
  count: HTMLElement;
  state: HTMLElement;
};

export class Roster {
  readonly root = document.createElement("div");
  private cards = new Map<string, Card>();
  private signature = "";
  private selected = new Set<string>();
  private lastCell = new Map<string, Cell>();

  constructor(
    private readonly onPick: (name: string, additive: boolean) => void,
    private readonly onCentre: (cell: Cell) => void,
  ) {
    this.root.className = "roster";
  }

  private card(binding: Binding): Card {
    const node = document.createElement("button");
    node.className = "card-unit";

    const head = document.createElement("span");
    head.className = "card-head";
    const mark = document.createElement("span");
    mark.className = "card-mark";
    const name = document.createElement("strong");
    name.textContent = binding.name;
    const count = document.createElement("span");
    count.className = "card-count";
    head.append(mark, name, count);

    const track = document.createElement("span");
    track.className = "card-track";
    const fill = document.createElement("i");
    track.append(fill);

    const state = document.createElement("span");
    state.className = "card-state";

    node.append(head, track, state);
    node.addEventListener("click", (event) => {
      const at = this.lastCell.get(binding.name);
      if (this.selected.has(binding.name) && at) this.onCentre(at);
      else this.onPick(binding.name, event.shiftKey);
    });
    return { node, mark, fill, count, state };
  }

  /** What the formation is doing, in the order a player wants to hear it. */
  private state(match: Match, binding: Binding): { text: string; flag: string } {
    if (binding.order.kind === "retreat") return { text: "falling back", flag: "routing" };
    if (binding.contactLatch) return { text: "under fire", flag: "fired-on" };
    if (binding.weakLatch) return { text: "cut up", flag: "spent" };
    if (!binding.arrived && binding.order.cells.length) {
      return { text: ORDER_DOING[binding.order.kind], flag: "moving" };
    }
    const firing = match.bindingUnits(binding).some((unit) => unit.reload > 0);
    if (firing) return { text: "firing", flag: "firing" };
    return { text: ORDER_DOING[binding.order.kind], flag: "idle" };
  }

  update(match: Match, selection: Set<string>) {
    this.selected = selection;
    const mine = [...match.bindings.values()].filter((binding) => binding.side === "player");
    const key = mine.map((binding) => binding.name).join(",");
    if (key !== this.signature) {
      this.signature = key;
      this.cards.clear();
      this.root.replaceChildren();
      for (const binding of mine) {
        const built = this.card(binding);
        // A formation's arm is whatever it is made of.
        const arm: UnitType = match.bindingUnits(binding)[0]?.type ?? "infantry";
        built.mark.textContent = MARK[arm];
        built.node.dataset.arm = arm;
        built.node.title = `${binding.name} — ${ARM[arm]}. Click to take it, click again to go to it.`;
        this.cards.set(binding.name, built);
        this.root.append(built.node);
      }
      this.root.dataset.empty = mine.length ? "0" : "1";
    }

    for (const binding of mine) {
      const card = this.cards.get(binding.name);
      if (!card) continue;
      const alive = match.bindingUnits(binding).length;
      const share = binding.establishment ? alive / binding.establishment : 0;
      const state = this.state(match, binding);
      card.fill.style.width = `${Math.round(share * 100)}%`;
      card.count.textContent = `${alive}/${binding.establishment}`;
      card.state.textContent = state.text;
      card.node.dataset.state = state.flag;
      card.node.dataset.on = selection.has(binding.name) ? "1" : "0";
      card.node.dataset.hurt = share < 0.4 ? "1" : "0";
      this.lastCell.set(binding.name, match.bindingCell(binding));
    }
  }
}
