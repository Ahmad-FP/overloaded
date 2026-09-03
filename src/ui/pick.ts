/**
 * A dropdown that belongs to this game.
 *
 * A native `<select>` opens the operating system's own menu -- a white list in
 * the system font, dropped over a board that is otherwise entirely engraved
 * brass and oiled walnut. It also cannot be styled, cannot be scrolled with the
 * rest of a panel, and on the desktop it steals the keyboard.
 *
 * So the control is built here: a struck key that reads its current value, and
 * a list that opens in a layer above everything, positioned in viewport
 * coordinates so no panel's overflow can clip it.
 */

export type Option = readonly [value: string, label: string];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The one open list. Opening another closes it, as a menu bar would. */
let open: { list: HTMLElement; close: () => void } | null = null;

export const closeMenus = () => {
  open?.close();
  open = null;
};

document.addEventListener("pointerdown", (event) => {
  if (!open) return;
  const target = event.target as Node | null;
  if (target && open.list.contains(target)) return;
  closeMenus();
}, true);

document.addEventListener("keydown", (event) => {
  if (!open) return;
  if (event.key === "Escape") {
    event.stopPropagation();
    event.preventDefault();
    closeMenus();
  }
}, true);

window.addEventListener("resize", () => closeMenus());

export type Dropdown = HTMLButtonElement & { setOptions: (options: Option[], value: string) => void };

export const dropdown = (
  options: Option[],
  value: string,
  onPick: (value: string) => void,
  className = "",
): Dropdown => {
  const button = el("button", `pick ${className}`.trim()) as Dropdown;
  button.type = "button";
  const text = el("span", "pick-text");
  const caret = el("span", "pick-caret");
  button.append(text, caret);

  let current: Option[] = options;
  let chosen = value;

  const paint = () => {
    text.textContent = current.find(([key]) => key === chosen)?.[1] ?? chosen;
  };

  const show = () => {
    closeMenus();
    const list = el("div", "pick-menu");
    for (const [key, label] of current) {
      const item = el("button", "pick-item", label);
      item.type = "button";
      item.dataset.on = key === chosen ? "1" : "0";
      item.addEventListener("click", () => {
        chosen = key;
        paint();
        closeMenus();
        onPick(key);
      });
      list.append(item);
    }
    document.body.append(list);

    // Placed against the viewport, then flipped up if the list would run off
    // the bottom of the window -- a rule near the foot of the rail is as
    // common as one at the top.
    const box = button.getBoundingClientRect();
    const height = list.offsetHeight;
    const below = window.innerHeight - box.bottom - 8;
    list.style.minWidth = `${Math.max(box.width, 150)}px`;
    list.style.left = `${Math.min(box.left, window.innerWidth - list.offsetWidth - 8)}px`;
    list.style.top = height > below && box.top > height
      ? `${box.top - height - 4}px`
      : `${box.bottom + 4}px`;
    list.dataset.on = "1";
    button.dataset.open = "1";

    open = {
      list,
      close: () => {
        list.remove();
        button.dataset.open = "0";
      },
    };
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (button.dataset.open === "1") return closeMenus();
    show();
  });
  // The board reads raw keys for orders; a control the player is typing into
  // must not also charge the cavalry.
  button.addEventListener("keydown", (event) => event.stopPropagation());

  button.setOptions = (next: Option[], nextValue: string) => {
    current = next;
    chosen = nextValue;
    paint();
  };

  paint();
  return button;
};
