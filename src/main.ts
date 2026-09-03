import "@fontsource-variable/cinzel";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/oswald";
import "./style.css";
import { audio } from "./audio/sound";
import { TILE_M } from "./domain/constants";
import {
  addRule, buildFob, issue, recruit, removeRule, startBattle, tickMatch, updateRule,
} from "./domain/commands";
import { Match } from "./domain/match";
import type { Alert, Cell, EventKind, MapId, OrderKind, Rule } from "./domain/types";
import { Board } from "./render/board";
import { Hud } from "./ui/hud";
import { Overlay } from "./ui/overlay";
import { Shell } from "./ui/shell";
import { registerWebMCPTools } from "./webmcp/register";

const host = document.querySelector("#app");
if (!(host instanceof HTMLElement)) throw new Error("Missing #app");
host.replaceChildren();
if (import.meta.hot) import.meta.hot.dispose(() => location.reload());

const match = new Match();
const board = new Board(host);
const view = new Overlay(host, board);

/** Orders that need somewhere to go; the rest apply the moment you ask. */
const NEEDS_CELL: ReadonlySet<OrderKind> = new Set<OrderKind>(["move", "attack_area", "bombard", "charge", "retreat"]);

/** Which alert deserves which horn. */
const CUE_OF: Partial<Record<EventKind, Parameters<typeof audio.play>[0]>> = {
  spotted: "spotted",
  under_fire: "under_fire",
  weakened: "weakened",
  supply_cut: "supply_cut",
  supply_restored: "supply_restored",
  captured: "captured",
  lost: "lost",
  threatened: "threatened",
  destroyed: "destroyed",
};

let pendingOrder: OrderKind | null = null;
let speed = 1;
let webmcp = { registered: false, count: 0 };

const selected = () => [...view.selection].filter((name) => match.bindingByName(name));

const report = (result: { ok: boolean; error?: { message: string } }, good: Parameters<typeof audio.play>[0]) => {
  if (result.ok) audio.play(good);
  else {
    audio.play("cancel");
    if (result.error) note(result.error.message);
  }
};

let noteTimer = 0;
const toast = document.createElement("p");
toast.className = "toast";
const note = (text: string) => {
  toast.textContent = text;
  toast.dataset.on = "1";
  noteTimer = 2.8;
};

const applyOrder = (kind: OrderKind, cells: Cell[]) => {
  const names = selected();
  if (!names.length) return;
  for (const name of names) issue(match, name, { order: kind, cells });
  audio.play(kind === "retreat" ? "cancel" : "confirm");

};

const hud = new Hud(host, {
  recruit: (structureId, type, count, grade) => {
    report(recruit(match, structureId, type, count, grade), "recruit");
  },
  beginBuild: () => {
    view.placing = !view.placing;
    hud.setBuilding(view.placing);
    audio.play(view.placing ? "open" : "close");
  },
  order: (kind) => {
    if (NEEDS_CELL.has(kind)) {
      pendingOrder = kind;
      audio.play("click");
      note(`${kind.replace("_", " ")} — right-click the ground.`);
      return;
    }
    applyOrder(kind, []);
  },
  setShape: (shape) => { for (const name of selected()) issue(match, name, { shape }); audio.play("click"); },
  setPriority: (priority) => { for (const name of selected()) issue(match, name, { priority }); audio.play("click"); },
  setEngage: (engageRange) => { for (const name of selected()) issue(match, name, { engageRange }); },
  setHoldFire: (holdFire) => { for (const name of selected()) issue(match, name, { holdFire }); audio.play("click"); },
  setLoad: (load) => { for (const name of selected()) issue(match, name, { load }); audio.play("click"); },
  focus: (cell) => { board.centreOn(cell); audio.play("click"); },
  togglePause: () => { match.setPaused(!match.paused); audio.play(match.paused ? "close" : "open"); },
  setSpeed: (value) => { speed = value; audio.play("click"); },
  toggleMute: () => {
    const muted = !audio.muted;
    audio.setMuted(muted);
    hud.setMuted(muted);
    if (!muted) audio.play("click");
  },
  addRule: () => {
    const result = addRule(match, {});
    report(result, "stamp");
  },
  changeRule: (id, patch) => { updateRule(match, id, patch as Partial<Rule>); audio.play("click"); },
  removeRule: (id) => { removeRule(match, id); audio.play("cancel"); },
});
host.append(toast);

const shell = new Shell(host, {
  setMap: (id: MapId) => { match.setSettings({ mapId: id }); audio.play("click"); },
  setMinutes: (minutes) => { match.setSettings({ timeLimitS: minutes * 60 }); audio.play("click"); },
  setDifficulty: (difficulty) => { match.setSettings({ difficulty }); audio.play("click"); },
  begin: () => {
    const result = startBattle(match);
    if (!result.ok) return audio.play("cancel");
    view.selection.clear();
    board.build(match.world);
    board.centreOn(match.world.mainCells.player);
    audio.play("confirm");
    audio.ambience(true);
    paint();
  },
  again: () => {
    audio.ambience(false);
    reset();
  },
});

type Debug = Window & { __MATCH__?: Match; __VIEW__?: Overlay; __BOARD__?: Board; __AUDIO__?: typeof audio };
(window as Debug).__MATCH__ = match;
(window as Debug).__VIEW__ = view;
(window as Debug).__BOARD__ = board;
(window as Debug).__AUDIO__ = audio;

const paint = () => shell.paint(match, webmcp);

const reset = () => {
  const fresh = new Match(match.settings);
  Object.assign(match, fresh);
  match.phase = "boot";
  view.selection.clear();
  paint();
};

// -- input -----------------------------------------------------------------

const canvas = view.canvas;
let dragging: null | { mode: "pan" | "marquee"; x: number; y: number } = null;
let pressStart = { x: 0, y: 0, at: 0 };

const local = (event: PointerEvent | WheelEvent) => {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
};

canvas.addEventListener("contextmenu", (event) => event.preventDefault());

canvas.addEventListener("pointerdown", (event) => {
  audio.unlock();
  if (match.phase !== "battle") return;
  const at = local(event);
  canvas.setPointerCapture(event.pointerId);
  if (event.button === 2 || event.button === 1) {
    dragging = { mode: event.button === 1 ? "pan" : "marquee", x: at.x, y: at.y };
    if (event.button === 1) return;
    dragging = null;
    orderAt(at, event.shiftKey);
    return;
  }
  if (view.placing) {
    const cell = board.toCell(at.x, at.y);
    const result = buildFob(match, cell);
    report(result, "built");
    if (result.ok) {
      view.placing = false;
      hud.setBuilding(false);
    }
    return;
  }
  pressStart = { x: at.x, y: at.y, at: performance.now() };
  dragging = { mode: "marquee", x: at.x, y: at.y };
  view.marquee = { x0: at.x, y0: at.y, x1: at.x, y1: at.y };
});

canvas.addEventListener("pointermove", (event) => {
  const at = local(event);
  view.hover = match.phase === "battle" ? board.toCell(at.x, at.y) : null;
  if (!dragging) return;
  if (dragging.mode === "pan") {
    board.panBy(dragging.x - at.x, dragging.y - at.y);
    dragging.x = at.x;
    dragging.y = at.y;
    return;
  }
  if (view.marquee) {
    view.marquee.x1 = at.x;
    view.marquee.y1 = at.y;
  }
});

const endDrag = (event: PointerEvent) => {
  if (!dragging) return;
  const at = local(event);
  const box = view.marquee;
  dragging = null;
  view.marquee = null;
  if (!box) return;
  const travelled = Math.hypot(at.x - pressStart.x, at.y - pressStart.y);
  if (travelled < 6) {
    const binding = view.bindingAt(match, at.x, at.y);
    if (!event.shiftKey) view.selection.clear();
    if (binding && binding.side === "player") {
      view.selection.add(binding.name);
      audio.play("click");
    } else {
      const structure = view.structureAt(match, board.toCell(at.x, at.y));
      if (structure && structure.side === "player") audio.play("click");
    }
    return;
  }
  if (!event.shiftKey) view.selection.clear();
  let found = 0;
  for (const binding of view.bindingsIn(match, box)) {
    if (binding.side !== "player") continue;
    view.selection.add(binding.name);
    found += 1;
  }
  if (found) audio.play("confirm");
};

canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

const orderAt = (at: { x: number; y: number }, append: boolean) => {
  if (view.placing) {
    view.placing = false;
    hud.setBuilding(false);
    audio.play("cancel");
    return;
  }
  const cell = board.toCell(at.x, at.y);
  const names = selected();
  if (!names.length) return;
  let kind = pendingOrder;
  if (!kind) {
    const foe = view.bindingAt(match, at.x, at.y);
    const work = view.structureAt(match, cell);
    const hostile = (foe && foe.side === "enemy") || (work && work.side !== "player");
    kind = hostile ? "attack_area" : "move";
  }
  pendingOrder = null;
  if (append) {
    for (const name of names) {
      const binding = match.bindingByName(name);
      if (!binding) continue;
      binding.order.sequence.push({ waitS: 0, order: kind, cells: [cell] });
    }
    audio.play("stamp");
    return;
  }
  applyOrder(kind, [cell]);
};

canvas.addEventListener("wheel", (event) => {
  if (match.phase !== "battle") return;
  event.preventDefault();
  board.zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

const held = new Set<string>();
window.addEventListener("keyup", (event) => held.delete(event.code));
window.addEventListener("blur", () => held.clear());
window.addEventListener("keydown", (event) => {
  audio.unlock();
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
  if (typing) return;
  held.add(event.code);
  if (match.phase !== "battle") return;
  const verb: Partial<Record<string, OrderKind>> = {
    KeyA: "attack_area", KeyH: "hold", KeyF: "retreat", KeyC: "charge",
    KeyG: "bombard", KeyR: "reserve", KeyV: "move",
  };
  const wanted = verb[event.code];
  if (wanted) {
    event.preventDefault();
    if (NEEDS_CELL.has(wanted)) {
      pendingOrder = wanted;
      note(`${wanted.replace("_", " ")} — right-click the ground.`);
      audio.play("click");
    } else applyOrder(wanted, []);
    return;
  }
  if (event.code === "KeyP" || event.code === "Space") {
    event.preventDefault();
    match.setPaused(!match.paused);
    audio.play(match.paused ? "close" : "open");
  }
  if (event.code === "KeyB") {
    view.placing = !view.placing;
    hud.setBuilding(view.placing);
    audio.play(view.placing ? "open" : "close");
  }
  if (event.code === "KeyM") {
    const muted = !audio.muted;
    audio.setMuted(muted);
    hud.setMuted(muted);
  }
  if (event.code === "Escape") {
    if (view.placing) { view.placing = false; hud.setBuilding(false); }
    else if (pendingOrder) pendingOrder = null;
    else view.selection.clear();
    audio.play("cancel");
  }
  if (event.code === "KeyE") {
    const mine = match.structuresOf("player");
    const main = mine.find((structure) => structure.kind === "main");
    if (main) board.centreOn(main.cell);
  }
  if (event.code.startsWith("Digit")) {
    const digit = Number(event.code.slice(5));
    if (digit >= 1 && digit <= 4) { speed = [1, 1, 2, 4][digit - 1] ?? 1; audio.play("click"); }
  }
});

window.addEventListener("resize", () => {
  board.resize();
  view.resize();
});
window.addEventListener("pointerdown", () => audio.unlock(), { once: true });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) audio.suspend();
  else audio.resume();
});

// -- sound from the field ---------------------------------------------------

let seenAlert = "";
let seenMelee = 0;
let seenResult: Match["result"] = null;

const bearing = (cell: Cell) => {
  const dx = cell.x - board.target.x;
  const dy = cell.y - board.target.y;
  return { distance: Math.hypot(dx, dy), pan: Math.max(-1, Math.min(1, dx / 26)) };
};

const soundOff = () => {
  const fresh: Alert[] = [];
  for (const alert of match.alerts) {
    if (alert.id === seenAlert) break;
    if (alert.side === "player") fresh.push(alert);
  }
  const first = match.alerts[0];
  if (first) seenAlert = first.id;
  for (const alert of fresh.slice(0, 3).reverse()) {
    const cue = CUE_OF[alert.event];
    if (!cue) continue;
    const { distance, pan } = bearing(alert.cell);
    audio.play(cue, { distance: Math.min(distance, 30), pan });
  }

  // A line of forty firing together should sound like a line of forty, not
  // like one man: fold everything fired this frame into one report per kind,
  // heard from its centre and swelling with the number of muzzles.
  const volleys = new Map<string, { n: number; x: number; z: number }>();
  const stamp = performance.now() / 1000;
  for (const shot of match.takeReports()) {
    view.flash(shot.x, shot.z, stamp);
    const cue = shot.kind === "musket" ? "volley" : "cannon";
    const seen = volleys.get(cue) ?? { n: 0, x: 0, z: 0 };
    volleys.set(cue, { n: seen.n + 1, x: seen.x + shot.x, z: seen.z + shot.z });
  }
  for (const [cue, fire] of volleys) {
    const { distance, pan } = bearing({ x: fire.x / fire.n / TILE_M, y: fire.z / fire.n / TILE_M });
    if (distance > 44) continue;
    audio.play(cue as Parameters<typeof audio.play>[0], {
      distance,
      pan,
      gain: Math.min(1.6, 0.75 + Math.log2(fire.n + 1) * 0.28),
    });
  }

  if (match.melee > seenMelee) {
    seenMelee = match.melee;
    audio.play("clash", { distance: 6 });
  }
  if (match.result && match.result !== seenResult) {
    seenResult = match.result;
    audio.ambience(false);
    audio.play(match.result === "win" ? "victory" : "defeat");
  }
};

// -- loop -------------------------------------------------------------------

const STEP = 1 / 20;
let accumulator = 0;
let previous = performance.now();
let lastPhase: Match["phase"] = "boot";

const frame = (now: number) => {
  const dt = Math.min(0.1, (now - previous) / 1000);
  previous = now;

  if (match.phase === "battle") {
    accumulator += dt * speed;
    let steps = 0;
    while (accumulator >= STEP && steps < 12) {
      tickMatch(match, STEP);
      accumulator -= STEP;
      steps += 1;
    }
    const panSpeed = 700 * dt / board.zoom;
    let px = 0;
    let py = 0;
    if (held.has("KeyW") || held.has("ArrowUp")) py -= panSpeed;
    if (held.has("KeyS") || held.has("ArrowDown")) py += panSpeed;
    if (held.has("ArrowLeft")) px -= panSpeed;
    if (held.has("ArrowRight")) px += panSpeed;
    if (px || py) board.panBy(px, py);
    soundOff();
    view.think(match, now / 1000, dt);
    board.sync(match);
    board.render();
    view.draw(match, now / 1000);
    hud.update(match, view.selection);
  }

  if (match.phase !== lastPhase) {
    lastPhase = match.phase;
    document.body.dataset.phase = match.phase;
    paint();
  }

  if (noteTimer > 0) {
    noteTimer -= dt;
    if (noteTimer <= 0) toast.dataset.on = "0";
  }
  requestAnimationFrame(frame);
};

const boot = async () => {
  webmcp = await registerWebMCPTools(match);
  paint();
};

document.body.dataset.phase = "boot";
paint();
void boot();
requestAnimationFrame(frame);
