import type { Terrain, UnitType } from "./types";

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
export const DEPOT_YIELD = 45;

export const DEFAULT_TIME_S = 20 * 60;

/** How often the supply graph is rebuilt, in seconds. A BFS per structure. */
export const SUPPLY_INTERVAL_S = 0.5;
/** Tiles around an enemy body that a supply route may not pass through. */
export const INTERDICT_TILES = 2;
/** Tiles around an enemy structure that are interdicted. */
export const INTERDICT_STRUCTURE_TILES = 3;

/** A new work has to be raised within reach of the network it extends. */
export const WORK_REACH_TILES = 14;
export const WORK_MIN_SPACING_TILES = 5;

/**
 * The works a side can raise.
 *
 * Civilization VI's districts put the decision in the ground rather than the
 * menu -- its lead producer's stated goal was that "the map be more important
 * than it had ever been" -- so each work here wants a particular kind of
 * ground next to it and pays for being sited well. A foundry next to woods has
 * charcoal; stables on open ground have grazing; a watchtower on a hill sees
 * further. Placement is the interesting part, not the purchase.
 *
 * `boon` is what the adjacency multiplies: raise speed for the arms sheds,
 * hp for a fort, sight for a tower.
 */
export type WorkKind = "fort" | "barracks" | "stables" | "foundry" | "watchtower";

export const WORKS: Record<WorkKind, {
  name: string;
  blurb: string;
  cost: number;
  buildS: number;
  yield: number;
  hp: number;
  span: number;
  /** Ground that pays a bonus when it touches this work. */
  wants: { terrain?: Terrain; highGround?: boolean; label: string };
  boon: number;
}> = {
  fort: {
    name: "Fort",
    blurb: "Holds ground and carries supply forward.",
    cost: 300, buildS: 22, yield: 30, hp: 900, span: 1,
    wants: { terrain: "rough", highGround: true, label: "Stronger on broken or high ground" },
    boon: 1.5,
  },
  barracks: {
    name: "Barracks",
    blurb: "Raises infantry faster and cheaper.",
    cost: 220, buildS: 18, yield: 0, hp: 700, span: 1,
    wants: { terrain: "road", label: "Faster beside a road" },
    boon: 1.4,
  },
  stables: {
    name: "Stables",
    blurb: "Raises cavalry faster and cheaper.",
    cost: 260, buildS: 20, yield: 0, hp: 700, span: 1,
    wants: { terrain: "open", label: "Faster with open ground to graze" },
    boon: 1.4,
  },
  foundry: {
    name: "Foundry",
    blurb: "Casts guns faster, cheaper and heavier.",
    cost: 340, buildS: 26, yield: 0, hp: 800, span: 1,
    wants: { terrain: "woods", label: "Faster beside woods, for charcoal" },
    boon: 1.5,
  },
  watchtower: {
    name: "Watchtower",
    blurb: "Sees far beyond the line.",
    cost: 120, buildS: 10, yield: 0, hp: 400, span: 1,
    wants: { highGround: true, label: "Sees further from high ground" },
    boon: 1.6,
  },
};

/** The works menu, in the order they are offered. */
export const WORK_KINDS = ["fort", "barracks", "stables", "foundry", "watchtower"] as const;

/** Which arm each shed serves. A fort and a tower serve none. */
export const WORK_TRADE: Partial<Record<WorkKind, UnitType>> = {
  barracks: "infantry",
  stables: "cavalry",
  foundry: "artillery",
};

/** Tiles of extra sight a finished watchtower gives. */
export const TOWER_SIGHT_TILES = 9;

/** Ground at or above this counts as high, for siting and for towers. */
export const HIGH_GROUND_M = 5.5;

/** True for anything a side can raise, as opposed to an HQ or a depot. */
export const isWork = (kind: string): kind is WorkKind =>
  kind !== "main" && kind !== "depot";

export const DEPOT_CAPTURE_S = 8;
export const CAPTURE_TILES = 1.6;

export const BASE_COST = { infantry: 11, cavalry: 27, artillery: 130 } as const;
/** Seconds to raise one body, before the count multiplier. */
export const RECRUIT_TIME_S = { infantry: 0.5, cavalry: 0.9, artillery: 8 } as const;
/** Grade multiplies both the bill and the wait. */
export const GRADE_COST = [1, 1, 1.45, 2.1] as const;

export const HP = { main: 4200, depot: 600 } as const;
export const SPAN = { main: 2, depot: 1 } as const;

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
 * The order vocabulary.
 *
 * Every standing order is written against one named formation or one named
 * building -- never "any formation" -- so both halves of it point at something
 * the player can see on the field. The same words are exported verbatim into
 * the WebMCP schema, so an agent and the player write the same orders.
 */

/** What a watch can be set on, and what it can be set for. */
export const TRIGGERS = [
  "under_fire", "spotted", "weakened", "arrived", "idle",
  "threatened", "supply_cut", "supply_restored", "captured", "lost", "destroyed",
  "supply_above",
] as const;

export const ACTIONS = [
  "move", "hold", "attack_area", "bombard", "charge", "retreat", "reserve", "recruit",
] as const;

/** Triggers that carry an enemy position, so "the attacker" is a real place. */
export const CONTACT_TRIGGERS = ["under_fire", "spotted", "threatened"] as const;
