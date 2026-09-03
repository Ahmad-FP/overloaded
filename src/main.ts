import "@fontsource-variable/cinzel";
import "@fontsource-variable/source-serif-4";
import "@fontsource-variable/oswald";
import "./style.css";
import { audio } from "./audio/sound";
import { TILE_M } from "./domain/constants";
import {
  addRule, buildWork, issue, recruit, removeRule, startBattle, tickMatch, updateRule,
} from "./domain/commands";
import { Match } from "./domain/match";
import type { Alert, Cell, MapId, OrderKind, Rule, Trigger } from "./domain/types";
import { Board } from "./render/board";
import { Hero } from "./render/hero";
import { Coach } from "./ui/coach";
import { ORDER_BY_CODE } from "./ui/keys";
import { Hud } from "./ui/hud";
import { Minimap } from "./ui/minimap";
import { Overlay } from "./ui/overlay";
import { Roster } from "./ui/roster";
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
const CUE_OF: Partial<Record<Trigger, Parameters<typeof audio.play>[0]>> = {
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
/** An order waiting for the player to mark the ground it aims at. */
let markingFor: string | null = null;
let speed = 1;

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
  coach.mark("order");
  for (const name of names) issue(match, name, { order: kind, cells });
  audio.play(kind === "retreat" ? "cancel" : "confirm");

};

const hud = new Hud(host, {
  recruit: (structureId, type, count, grade) => {
    report(recruit(match, structureId, type, count, grade), "recruit");
    coach.mark("recruit");
  },
  beginBuild: (kind) => {
    view.placing = view.placing === kind ? null : kind;
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
  pickWork: (id) => { view.work = id; if (id) view.selection.clear(); },
  togglePause: () => { match.setPaused(!match.paused); audio.play(match.paused ? "close" : "open"); },
  setSpeed: (value) => { speed = value; audio.play("click"); },
  toggleMute: () => {
    const muted = !audio.muted;
    audio.setMuted(muted);
    hud.setMuted(muted);
    if (!muted) audio.play("click");
  },
  addRule: (seed) => {
    // A new order is written to whatever the player has in hand, so the card
    // opens already pointed at something instead of at nothing.
    const first = [...selected()][0];
    const held = first ? { kind: "binding" as const, ref: first } : undefined;
    const at = held ?? (view.work ? { kind: "structure" as const, ref: view.work } : undefined);
    const result = addRule(match, {
      ...(at ? { watch: at, actor: at } : {}),
      ...(at?.kind === "structure"
        ? { watch: { kind: "chest" as const }, trigger: "supply_above" as const, action: "recruit" as const }
        : { trigger: "under_fire" as const, action: "attack_area" as const, place: { kind: "attacker" as const } }),
      ...seed,
    });
    report(result, "stamp");
    coach.mark("rules");
  },
  pickPlace: (id) => {
    markingFor = id;
    view.marking = true;
    audio.play("open");
  },
  changeRule: (id, patch) => { updateRule(match, id, patch as Partial<Rule>); audio.play("click"); },
  removeRule: (id) => { removeRule(match, id); audio.play("cancel"); },
});
host.append(toast);

const coach: Coach = new Coach(() => audio.play("close"));
host.append(coach.root);

const takeTheField = () => {
  const result = startBattle(match);
  if (!result.ok) return audio.play("cancel");
  view.selection.clear();
  board.build(match.world);
  audio.play("confirm");
  audio.ambience(true);
  paint();
};

const shell = new Shell(host, {
  setMap: (id: MapId) => { match.setSettings({ mapId: id }); audio.play("click"); paint(); },
  setArea: (area: number) => { match.setSettings({ mapArea: area }); audio.play("click"); paint(); },
  setMinutes: (minutes) => { match.setSettings({ timeLimitS: minutes * 60 }); audio.play("click"); paint(); },
  setDifficulty: (difficulty) => { match.setSettings({ difficulty }); audio.play("click"); paint(); },
  begin: () => { coach.setOff(true); takeTheField(); },
  beginTutorial: () => {
    // The tutorial is a battle, not a mode: an open field, a long clock and
    // the weakest opposition, with the coach reset so it teaches from the top
    // however many matches the player has already finished.
    match.setSettings({ mapId: "plain", difficulty: 1, timeLimitS: 2100 });
    coach.setOff(false);
    coach.reset();
    takeTheField();
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

const paint = () => shell.paint(match);

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
  if (markingFor) {
    // The player is marking the ground a standing order aims at.
    const cell = board.toCell(at.x, at.y);
    updateRule(match, markingFor, { place: { kind: "point", cell } });
    hud.book.reopen(markingFor);
    markingFor = null;
    view.marking = false;
    audio.play("stamp");
    return;
  }
  if (view.placing) {
    const cell = board.toCell(at.x, at.y);
    const result = buildWork(match, view.placing, cell);
    report(result, "built");
    if (result.ok) {
      view.placing = null;
      hud.setBuilding(null);
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
      view.work = null;
      view.selection.add(binding.name);
      audio.play("click");
    } else {
      const structure = view.structureAt(match, board.toCell(at.x, at.y));
      view.work = structure && structure.side === "player" ? structure.id : null;
      if (view.work) audio.play("click");
    }
    return;
  }
  if (!event.shiftKey) view.selection.clear();
  let found = 0;
  view.work = null;
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
    view.placing = null;
    hud.setBuilding(null);
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

/**
 * Step through the formations standing about.
 *
 * It keeps its own cursor rather than always jumping to the first, so holding
 * the button walks the whole list instead of bouncing off one formation.
 */
let idleCursor = 0;
const goToNextIdle = () => {
  const waiting = [...match.bindings.values()]
    .filter((binding) => binding.side === "player"
      && binding.order.kind !== "reserve"
      && binding.arrived
      && !binding.contactLatch
      && match.bindingUnits(binding).length > 0);
  if (!waiting.length) return;
  idleCursor = (idleCursor + 1) % waiting.length;
  const next = waiting[idleCursor];
  if (!next) return;
  view.selection.clear();
  view.work = null;
  view.selection.add(next.name);
  board.centreOn(match.bindingCell(next));
  audio.play("click");
};

const minimap = new Minimap(board, (cell) => board.centreOn(cell));
const roster = new Roster(
  (name, additive) => {
    if (!additive) view.selection.clear();
    view.work = null;
    view.selection.add(name);
    audio.play("click");
  },
  (cell) => { board.centreOn(cell); audio.play("click"); },
);
hud.attach(minimap.root, roster.root);

const held = new Set<string>();
window.addEventListener("keyup", (event) => {
  held.delete(event.code);
  if (event.code === "Space") view.showPaths = false;
});
window.addEventListener("blur", () => { held.clear(); view.showPaths = false; });
window.addEventListener("keydown", (event) => {
  audio.unlock();
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
  if (typing) return;
  held.add(event.code);
  if (match.phase !== "battle") return;
  const wanted = ORDER_BY_CODE.get(event.code);
  if (wanted) {
    event.preventDefault();
    if (NEEDS_CELL.has(wanted)) {
      pendingOrder = wanted;
      note(`${wanted.replace("_", " ")} — right-click the ground.`);
      audio.play("click");
    } else applyOrder(wanted, []);
    return;
  }
  if (event.code === "Tab") {
    event.preventDefault();
    goToNextIdle();
    return;
  }
  if (event.code === "KeyP") {
    event.preventDefault();
    match.setPaused(!match.paused);
    audio.play(match.paused ? "close" : "open");
  }
  // Held, not toggled: every formation's orders are wanted in bulk for a second
  // at a time, which is not worth permanent screen.
  if (event.code === "Space") {
    event.preventDefault();
    view.showPaths = true;
  }
  if (event.code === "KeyL") {
    audio.play("click");
    minimap.cycleLens();
  }
  if (event.code === "KeyB") {
    view.placing = view.placing ? null : "fort";
    hud.setBuilding(view.placing);
    audio.play(view.placing ? "open" : "close");
  }
  if (event.code === "KeyM") {
    const muted = !audio.muted;
    audio.setMuted(muted);
    hud.setMuted(muted);
  }
  if (event.code === "Escape") {
    if (markingFor) {
      hud.book.reopen(markingFor);
      markingFor = null;
      view.marking = false;
    }
    else if (view.placing) { view.placing = null; hud.setBuilding(null); }
    else if (pendingOrder) pendingOrder = null;
    else if (view.work) view.work = null;
    else view.selection.clear();
    audio.play("cancel");
  }
  if (event.code === "Home") {
    const mine = match.structuresOf("player");
    const main = mine.find((structure) => structure.kind === "main");
    if (main) board.centreOn(main.cell);
  }
  if (event.code.startsWith("Digit")) {
    const digit = Number(event.code.slice(5));
    if (digit >= 1 && digit <= 4) { speed = [1, 1, 2, 4][digit - 1] ?? 1; audio.play("click"); }
  }
});

// The title render is a still: it is drawn on resize and whenever the boot
// screen comes back, and never on a frame loop.
const hero = new Hero(shell.heroCanvas);
const drawHero = () => hero.resize(window.innerWidth, window.innerHeight);
drawHero();

window.addEventListener("resize", () => {
  board.resize();
  view.resize();
  if (match.phase !== "battle") drawHero();
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

const soundOff = (stamp: number) => {
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
    if (held.has("KeyA") || held.has("ArrowLeft")) px -= panSpeed;
    if (held.has("KeyD") || held.has("ArrowRight")) px += panSpeed;
    if (px || py) board.panBy(px, py);
    soundOff(now / 1000);
    view.think(match, now / 1000, dt);
    board.sync(match);
    board.render();
    view.draw(match, now / 1000);
    hud.update(match, view.selection, view.work);
    roster.update(match, view.selection);
    minimap.draw(match, view.known());
    coach.update(match, view.selection);
  }

  if (match.phase !== lastPhase) {
    lastPhase = match.phase;
    document.body.dataset.phase = match.phase;
    paint();
    if (match.phase === "boot") drawHero();
  }

  if (noteTimer > 0) {
    noteTimer -= dt;
    if (noteTimer <= 0) toast.dataset.on = "0";
  }
  requestAnimationFrame(frame);
};

const boot = async () => {
  await registerWebMCPTools(match);
  paint();
};

document.body.dataset.phase = "boot";
paint();
void boot();
requestAnimationFrame(frame);
