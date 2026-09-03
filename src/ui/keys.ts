import type { OrderKind } from "../domain/types";

/**
 * Order shortcuts.
 *
 * These deliberately avoid W, A, S and D. Those four pan the camera, and
 * binding an order to A meant that reaching for "pan left" ordered an attack
 * instead. Everything sits in the block to the right of WASD so one hand can
 * still pan and order without moving.
 *
 * This is the only place the letters are written down: the key handler and the
 * order buttons both read it, so a button can never advertise a key that does
 * something else.
 */
export const ORDER_KEY: Record<OrderKind, string> = {
  move: "Q",
  hold: "E",
  attack_area: "R",
  bombard: "T",
  charge: "F",
  retreat: "G",
  reserve: "C",
};

export const ORDER_BY_CODE: ReadonlyMap<string, OrderKind> = new Map(
  (Object.entries(ORDER_KEY) as Array<[OrderKind, string]>)
    .map(([order, key]) => [`Key${key}`, order]),
);

/** The rest of the board controls, for the key card and the README. */
export const CONTROL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["W A S D / arrows", "Pan the field"],
  ["Middle-drag", "Pan the field"],
  ["Wheel", "Zoom"],
  ["Left-click", "Select a formation; drag for several"],
  ["Right-click", "Send the selection, or confirm a pending order"],
  ["B", "Site a redoubt"],
  ["Home", "Centre on headquarters"],
  ["1 2 3 4", "Game speed"],
  ["Space or P", "Pause"],
  ["M", "Mute"],
  ["Esc", "Cancel the pending order, then the selection"],
];
