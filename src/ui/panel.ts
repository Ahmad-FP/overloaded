/**
 * Panel furniture.
 *
 * Every instrument on the board is the same object: a brass nameplate with a
 * title, whatever controls belong in the head, and a body that can be folded
 * away. Folding matters on a small screen and it matters mid-battle -- the
 * board is the thing being looked at, and a rail of open panels is a wall
 * standing in front of it.
 */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export type Panel = {
  root: HTMLElement;
  head: HTMLElement;
  /** Where a caller's own controls go, so the fold stays on the outside edge. */
  tools: HTMLElement;
  /** Everything under the head, hidden when the panel is folded. */
  body: HTMLElement;
  setFolded: (folded: boolean) => void;
};

/**
 * @param side which way the panel folds, so the chevron points off-screen.
 */
export const panel = (title: string, className = "", side: "left" | "right" = "left"): Panel => {
  const root = el("section", `panel ${className}`.trim());
  const head = el("header", "panel-head");
  const name = el("h2", undefined, title);
  const body = el("div", "panel-body");
  const tools = el("div", "panel-tools");

  const fold = el("button", "fold");
  const paint = () => {
    const folded = root.dataset.folded === "1";
    fold.textContent = folded === (side === "left") ? "›" : "‹";
    fold.title = folded ? `Open ${title.toLowerCase()}` : `Fold ${title.toLowerCase()} away`;
  };
  const setFolded = (folded: boolean) => {
    root.dataset.folded = folded ? "1" : "0";
    paint();
  };
  fold.addEventListener("click", () => setFolded(root.dataset.folded !== "1"));
  setFolded(false);

  // The chevron sits on the outside edge: left rail folds left, right folds
  // right, so the gesture matches where the panel goes.
  if (side === "left") head.append(name, tools, fold);
  else head.append(fold, name, tools);
  root.append(head, body);
  return { root, head, tools, body, setFolded };
};
