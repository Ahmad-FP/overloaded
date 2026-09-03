import { botThink } from "./bot";
import { Match, unitCost, type OrderPatch } from "./match";
import {
  inspectBinding, inspectCell, inspectContact, inspectStructure, overview, readAlerts,
} from "./observe";
import type { Cell, Quality, Rule, Side, UnitType } from "./types";

export const startBattle = (match: Match) => match.start();

/** How often the opposing staff makes a decision, by difficulty. */
const THINK_INTERVAL_S = [0, 6.5, 4.2, 2.8] as const;

export const tickMatch = (match: Match, dt: number) => {
  match.tick(dt);
  const interval = THINK_INTERVAL_S[match.settings.difficulty] ?? 4.2;
  if (match.phase === "battle" && !match.result && match.botAccum >= interval) {
    match.botAccum = 0;
    botThink(match);
  }
};

export const recruit = (match: Match, structureId: string, type: UnitType, count: number, grade: Quality = 2, side: Side = "player") =>
  match.recruit(side, structureId, type, count, grade);

export const buildFob = (match: Match, cell: Cell, side: Side = "player") => match.buildFob(side, cell);

export const bindUnits = (match: Match, unitIds: string[], name?: string, side: Side = "player") =>
  match.bind(side, unitIds, name);

export const unbind = (match: Match, name: string) => match.unbind(name);

export const renameBinding = (match: Match, from: string, to: string) => match.renameBinding(from, to);

export const issue = (match: Match, name: string, patch: OrderPatch, side: Side = "player") =>
  match.issue(name, patch, side);

export const addRule = (match: Match, patch: Partial<Rule>, side: Side = "player") => match.addRule(side, patch);
export const updateRule = (match: Match, id: string, patch: Partial<Rule>) => match.updateRule(id, patch);
export const removeRule = (match: Match, id: string) => match.removeRule(id);

export {
  inspectBinding, inspectCell, inspectContact, inspectStructure, overview, readAlerts, unitCost,
};
