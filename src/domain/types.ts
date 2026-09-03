import type {
  ACTIONS, LOADS, MAP_IDS, ORDERS, PRIORITIES, SHAPES, TRIGGERS,
  TERRAIN, UNIT_TYPES,
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

export type Trigger = (typeof TRIGGERS)[number];
export type ActionKind = (typeof ACTIONS)[number];

export type Cell = { x: number; y: number };

export type Settings = {
  timeLimitS: number;
  mapId: MapId;
  /** Field size as a multiple of the design grid: see FIELD_SIZES. */
  mapArea: number;
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
  /** Match clock when this formation last reported casualties. */
  hurtSaidAt: number;
  arrived: boolean;
  weakLatch: boolean;
  contactLatch: boolean;
  /** Seconds this formation has been on the march without making ground. */
  stallS: number;
  /** Where it was when the stall watch last saw it move. */
  mark: { x: number; z: number };
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

export type StructureKind = "main" | "depot" | "fort" | "barracks" | "stables" | "foundry" | "watchtower";

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
  /** Whether this work sits on the ground it wants, and what that pays. */
  sited: boolean;
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

/**
 * The three things a standing order can name.
 *
 * Every one of them is a specific thing on the field: a formation by name, a
 * building by id, the war chest, or a marked spot of ground. Nothing here is a
 * wildcard, so an order can never fire on a formation the player did not mean.
 */
export type Watched =
  | { kind: "binding"; ref: string }
  | { kind: "structure"; ref: string }
  | { kind: "chest" };

export type OrderActor =
  | { kind: "binding"; ref: string }
  | { kind: "structure"; ref: string };

/** The ground an order aims at. `attacker` is the enemy that set the watch off. */
export type OrderPlace =
  | { kind: "attacker" }
  | { kind: "binding"; ref: string }
  | { kind: "structure"; ref: string }
  | { kind: "point"; cell: Cell };

/**
 * One standing order.
 *
 * Written to one formation or one building, set off by one named thing, and
 * carried out on ground the order names. It is held by the thing it watches:
 * the moment that thing reports, the order goes out.
 */
export type Rule = {
  id: string;
  side: Side;
  enabled: boolean;
  watch: Watched;
  trigger: Trigger;
  /** Strength percentage for `weakened`, crates for `supply_above`. */
  threshold: number;
  actor: OrderActor;
  action: ActionKind;
  place: OrderPlace | null;
  /** Payload for `recruit`. */
  unitType: UnitType;
  count: number;
  once: boolean;
  cooldownS: number;
  cooldownLeft: number;
  fired: number;
};

export type Alert = {
  id: string;
  atS: number;
  side: Side;
  event: Trigger;
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
  event: Trigger;
  subjectKind: "binding" | "structure" | "chest";
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
  width: number;
  height: number;
  tiles: Terrain[];
  heights: number[];
  playerZone: { x0: number; x1: number; y0: number; y1: number };
  enemyZone: { x0: number; x1: number; y0: number; y1: number };
  features: Record<string, Cell[]>;
  /** How much ground this build covers, as a multiple of the design grid. */
  area: number;
  /** Where the two main bases stand and where the neutral depots sit. */
  mainCells: Record<Side, Cell>;
  depotCells: Cell[];
};

export type CommandResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
