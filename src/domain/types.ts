import type {
  ACTIONS, EVENTS, LOADS, MAP_IDS, ORDERS, PRIORITIES, SHAPES, TARGET_KINDS,
  TERRAIN, UNIT_TYPES, WHERE,
} from "./constants";

export type Side = "player" | "enemy";
export type Owner = Side | "neutral";
export type Phase = "boot" | "battle" | "result";
export type UnitType = (typeof UNIT_TYPES)[number];
export type Terrain = (typeof TERRAIN)[number];
export type Shape = (typeof SHAPES)[number];
export type OrderKind = (typeof ORDERS)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Load = (typeof LOADS)[number];
export type MapId = (typeof MAP_IDS)[number];
export type Quality = 1 | 2 | 3;
export type ResultKind = "win" | "lose" | "draw" | null;
export type ContactBand = "unknown" | "class" | "near";

export type EventKind = (typeof EVENTS)[number];
export type ActionKind = (typeof ACTIONS)[number];
export type WhereKind = (typeof WHERE)[number];
export type TargetKind = (typeof TARGET_KINDS)[number];

export type Cell = { x: number; y: number };

export type Settings = {
  timeLimitS: number;
  mapId: MapId;
  difficulty: 1 | 2 | 3;
};

export type SequenceStep = {
  waitS: number;
  order: OrderKind;
  cells: Cell[];
  holdFire?: boolean;
  engageRange?: number;
  load?: Load;
};

export type StandingOrder = {
  kind: OrderKind;
  cells: Cell[];
  holdFire: boolean;
  fireAtWill: boolean;
  engageRange: number;
  priority: Priority;
  load: Load;
  sequence: SequenceStep[];
  sequenceIndex: number;
  waitLeft: number;
  /** Match clock when this order was given, so a stalled march can be noticed. */
  setAt: number;
};

export type Binding = {
  id: string;
  name: string;
  side: Side;
  unitIds: string[];
  shape: Shape;
  spacing: number;
  facing: number;
  order: StandingOrder;
  /** Strength when the formation was last at full establishment. */
  establishment: number;
  /** Latched so `weakened` and `under_fire` fire on the edge, not every tick. */
  lastStrength: number;
  hurtAccum: number;
  arrived: boolean;
  weakLatch: boolean;
  contactLatch: boolean;
};

export type Unit = {
  id: string;
  side: Side;
  type: UnitType;
  weapon: Quality;
  powder: Quality;
  calibre: Quality;
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  alive: boolean;
  bindingId: string | null;
  reload: number;
  slot: number;
};

/**
 * One trigger pull, logged where it happened.
 *
 * Sound and muzzle flash key off these rather than off projectiles in flight:
 * a musket ball lives about a second, so on any frame the browser drops the
 * whole volley would be born and gone unheard between two renders.
 */
export type Report = { kind: "musket" | "ball" | "canister"; x: number; z: number };

export type Projectile = {
  id: string;
  kind: "musket" | "ball" | "canister";
  side: Side;
  /** Who fired it. A round may not detonate on the piece that threw it. */
  from: string;
  age: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  blast: number;
};

export type StructureKind = "main" | "fob" | "depot";

/**
 * A place on the map that holds ground.
 *
 * The main base is the root of a side's supply network, forward bases extend
 * it, and depots are the neutral prizes that pay for it. They share a shape
 * because supply, capture, damage and the rule book all want to treat them
 * as one kind of thing.
 */
export type Structure = {
  id: string;
  kind: StructureKind;
  side: Owner;
  name: string;
  cell: Cell;
  span: number;
  hp: number;
  maxHp: number;
  /** 0..1 while under construction; 1 once it works. */
  build: number;
  yield: number;
  connected: boolean;
  /** Tiles from this structure back to its main base, when one exists. */
  route: Cell[];
  /** 0..1 toward changing hands, and who is pushing. */
  capture: number;
  capturingSide: Owner;
  rally: Cell;
  /** Latches so supply and threat events fire on the edge. */
  cutLatch: boolean;
  threatLatch: boolean;
  hurtAccum: number;
};

export type ProductionOrder = {
  id: string;
  side: Side;
  structureId: string;
  type: UnitType;
  grade: Quality;
  count: number;
  totalS: number;
  leftS: number;
  bindingName: string;
};

export type RuleTarget = { kind: TargetKind; ref?: string };

/**
 * One line of the standing-orders book.
 *
 * WHEN <event> happens to <subject>, <actor> performs <action> at <where>.
 * The subject and the actor may be the same thing, which is how a formation
 * reacts to its own trouble.
 */
export type Rule = {
  id: string;
  side: Side;
  name: string;
  enabled: boolean;
  subject: RuleTarget;
  event: EventKind;
  threshold: number;
  actor: RuleTarget;
  action: ActionKind;
  where: WhereKind;
  cells: Cell[];
  /** Payload for `recruit` and `build_fob`. */
  unitType: UnitType;
  count: number;
  once: boolean;
  cooldownS: number;
  cooldownLeft: number;
  fired: number;
  timerLeft: number;
};

export type Alert = {
  id: string;
  atS: number;
  side: Side;
  event: EventKind;
  subject: string;
  subjectId: string;
  cell: Cell;
  text: string;
  ruleId: string | null;
  ruleName: string | null;
  response: string | null;
};

export type GameEvent = {
  side: Side;
  event: EventKind;
  subjectKind: "binding" | "structure";
  subjectId: string;
  subjectName: string;
  cell: Cell;
  /** Where the interesting thing was, if that differs from the subject. */
  eventCell: Cell;
  text: string;
};

export type Contact = {
  id: string;
  band: ContactBand;
  class?: UnitType | "mixed";
  count?: number;
  cell: Cell;
};

export type WorldMap = {
  id: MapId;
  name: string;
  job: string;
  width: number;
  height: number;
  tiles: Terrain[];
  heights: number[];
  playerZone: { x0: number; x1: number; y0: number; y1: number };
  enemyZone: { x0: number; x1: number; y0: number; y1: number };
  features: Record<string, Cell[]>;
  /** Where the two main bases stand and where the neutral depots sit. */
  mainCells: Record<Side, Cell>;
  depotCells: Cell[];
};

export type CommandResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
