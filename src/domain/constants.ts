export const TILE_M = 10;

/** Terrain datum. Water sits here; the lowest dry ground stands just above it. */
export const WATER_LEVEL_M = -0.18;
export const BANK_CLEARANCE_M = 0.42;
export const MIN_DEPTH_M = 0.9;

/** Starting crates, and the ceiling a side can bank. */
export const START_SUPPLY = 900;
export const MAX_SUPPLY = 6000;

/**
 * Crates per minute.
 *
 * The main base pays on its own so a side that loses the whole field can still
 * scrape a garrison together; everything above that has to be taken and held.
 */
export const MAIN_YIELD = 90;
export const DEPOT_YIELD = 110;
export const FOB_YIELD = 35;

export const DEFAULT_TIME_S = 20 * 60;

/** How often the supply graph is rebuilt, in seconds. A BFS per structure. */
export const SUPPLY_INTERVAL_S = 0.5;
/** Tiles around an enemy body that a supply route may not pass through. */
export const INTERDICT_TILES = 2;
/** Tiles around an enemy structure that are interdicted. */
export const INTERDICT_STRUCTURE_TILES = 3;

/** A forward base has to be built within reach of the network it extends. */
export const FOB_REACH_TILES = 14;
export const FOB_MIN_SPACING_TILES = 5;
export const FOB_COST = 320;
export const FOB_BUILD_S = 22;

export const DEPOT_CAPTURE_S = 8;
export const CAPTURE_TILES = 1.6;

export const BASE_COST = { infantry: 11, cavalry: 27, artillery: 130 } as const;
/** Seconds to raise one body, before the count multiplier. */
export const RECRUIT_TIME_S = { infantry: 0.5, cavalry: 0.9, artillery: 8 } as const;
/** Grade multiplies both the bill and the wait. */
export const GRADE_COST = [1, 1, 1.45, 2.1] as const;

export const HP = { main: 4200, fob: 900, depot: 600 } as const;
export const SPAN = { main: 2, fob: 1, depot: 1 } as const;

export const ID_NEAR_TILES = 8;
export const ID_MEDIUM_TILES = 18;

export const LANCE_SPEED = 6.2;
export const BAYONET_SPEED = 1.15;
export const MELEE_RANGE = 2.6;

/**
 * How far a formation sees, in tiles. The fog on the board and the sighting
 * that raises a "spotted" alert read the same number, so the game never
 * announces an enemy the player cannot see.
 */
export const SIGHT_TILES = 10;
export const MAIN_SIGHT_TILES = 14;

/** Damage a body does to a structure it is standing on, per second. */
export const SIEGE_DPS = { infantry: 2.6, cavalry: 1.4, artillery: 0 } as const;
/** Artillery battering a structure from range. */
export const ARTILLERY_SIEGE_HIT = 46;

export const NATO_NAMES = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel",
  "India", "Juliet", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa",
  "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "Xray",
  "Yankee", "Zulu",
] as const;

export const SHAPES = ["line", "column", "square", "skirmish"] as const;
export const UNIT_TYPES = ["infantry", "cavalry", "artillery"] as const;
export const ORDERS = [
  "move", "hold", "attack_area", "bombard", "charge", "retreat", "reserve",
] as const;
export const PRIORITIES = ["infantry", "cavalry", "artillery", "structure", "nearest"] as const;
export const LOADS = ["round", "canister"] as const;
export const TERRAIN = ["open", "road", "rough", "woods", "building", "water"] as const;
export const MAP_IDS = ["plain", "ridge", "longfield", "village"] as const;

/**
 * The trigger vocabulary.
 *
 * Everything the rule book can react to, and everything it can order in
 * response. Both lists are exported verbatim into the WebMCP schema, so an
 * agent and the player are looking at exactly the same language.
 */
export const EVENTS = [
  "spotted", "under_fire", "weakened", "arrived", "idle",
  "threatened", "supply_cut", "supply_restored", "captured", "lost",
  "destroyed", "timer",
] as const;
export const ACTIONS = [
  "move", "hold", "attack_area", "bombard", "charge", "retreat", "reserve",
  "build_fob", "recruit", "alert_only",
] as const;
export const WHERE = ["event_cell", "subject_cell", "actor_cell", "fixed"] as const;
export const TARGET_KINDS = [
  "binding", "structure", "self", "any_binding", "any_structure", "nearest_reserve",
] as const;
