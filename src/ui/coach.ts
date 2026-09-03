import type { Match } from "../domain/match";

/**
 * The tutorial.
 *
 * The board used to explain itself with a paragraph pinned under the order
 * tray that never went away, which is the worst of both worlds: new players
 * read it once, everyone else reads it forever.
 *
 * So it teaches the way Civilization's advisor does. One card at a time, in
 * the order the player will actually need it, each one retiring itself the
 * moment the player does the thing -- or when they dismiss it.
 *
 * It only runs when the player picks Tutorial from the title screen, so there
 * is nothing to remember between sessions and nothing to persist: choosing
 * Tutorial is the switch. A player who wants out mid-battle dismisses it.
 */

type Field = { match: Match; selection: Set<string> };

type Lesson = {
  id: string;
  title: string;
  body: string;
  /** Only offered once this is true -- no point teaching orders with nothing selected. */
  ready?: (field: Field) => boolean;
  /** Retires the card: the player has demonstrably got it. */
  learned?: (field: Field) => boolean;
};

const LESSONS: readonly Lesson[] = [
  {
    id: "select",
    title: "Take command",
    body: "Click a formation's banner to select it, or drag a box across several.",
    learned: ({ selection }) => selection.size > 0,
  },
  {
    id: "order",
    title: "Send them forward",
    body: "Right-click the ground to march there. The buttons in the tray decide what they do when they arrive.",
    ready: ({ selection }) => selection.size > 0,
  },
  {
    id: "recruit",
    title: "Raise more men",
    body: "Crates buy troops at any supplied base. Spend them from the panel on the left.",
    learned: ({ match }) => match.production.length > 0,
  },
  {
    id: "depot",
    title: "Depots pay",
    body: "Depots start neutral and pay whoever stands on one long enough. They are the whole match.",
    learned: ({ match }) => match.structuresOf("player").some((s) => s.kind === "depot"),
  },
  {
    id: "supply",
    title: "Cut the road",
    body: "A base only pays while it can walk crates home. Park a formation across their route and their income stops.",
  },
  {
    id: "rules",
    title: "Standing orders",
    body: "Pick a formation and write it a standing order. It watches for what you told it to watch for, and acts without waiting to be told.",
  },
];

export class Coach {
  readonly root = document.createElement("aside");
  private done = new Set<string>();
  /** Silent until the Tutorial entry turns it on. */
  private off = true;
  private showing: string | null = null;
  private card = document.createElement("div");

  constructor(private readonly onOff: (off: boolean) => void) {
    this.root.className = "coach";
    this.root.dataset.on = "0";
    this.card.className = "coach-card";
    this.root.append(this.card);
  }

  setOff(off: boolean) {
    this.off = off;
    if (off) this.hide();
  }

  /** Retire a lesson the player has just demonstrated. */
  mark(id: string) {
    if (this.done.has(id)) return;
    this.done.add(id);
    if (this.showing === id) this.hide();
  }

  /** Wipe the record, so the next match teaches from the top again. */
  reset() {
    this.done.clear();
    this.hide();
  }

  private hide() {
    this.showing = null;
    this.root.dataset.on = "0";
  }

  private draw(lesson: Lesson) {
    this.showing = lesson.id;
    this.card.replaceChildren();

    const head = document.createElement("h4");
    head.textContent = lesson.title;
    const body = document.createElement("p");
    body.textContent = lesson.body;

    const feet = document.createElement("div");
    feet.className = "coach-feet";
    const got = document.createElement("button");
    got.className = "coach-got";
    got.textContent = "Got it";
    got.addEventListener("click", () => this.mark(lesson.id));
    const mute = document.createElement("button");
    mute.className = "coach-mute";
    mute.textContent = "Turn off tips";
    mute.addEventListener("click", () => {
      this.setOff(true);
      this.onOff(true);
    });
    feet.append(got, mute);

    this.card.append(head, body, feet);
    this.root.dataset.on = "1";
  }

  update(match: Match, selection: Set<string>) {
    if (this.off || match.phase !== "battle") {
      if (this.showing) this.hide();
      return;
    }
    const field = { match, selection };

    // Anything already satisfied retires quietly, whether it was on screen or
    // not -- a player who selects a formation before being told has learnt it.
    for (const lesson of LESSONS) {
      if (!this.done.has(lesson.id) && lesson.learned?.(field)) this.mark(lesson.id);
    }

    const next = LESSONS.find((lesson) =>
      !this.done.has(lesson.id) && (lesson.ready?.(field) ?? true));
    if (!next) {
      if (this.showing) this.hide();
      return;
    }
    if (next.id !== this.showing) this.draw(next);
  }
}
