/**
 * Facts about the target format, verified against the Showdown source
 * (see ARCHITECTURE.md §1). Keep these in one place so they can be re-verified
 * with `npm run verify:showdown`.
 */
export const FORMAT_NAME = '[Gen 9 Champions] VGC 2026 Reg M-B (Bo3)';
export const FORMAT_ID = 'gen9championsvgc2026regmbbo3';
export const FORMAT_MOD = 'champions';
export const FORMAT_GAME_TYPE = 'doubles';
export const FORMAT_RULESET = ['Flat Rules', 'VGC Timer', 'Force Open Team Sheets', 'Best of = 3'] as const;

export const BEST_OF = 3;
export const WIN_THRESHOLD = 2;
/** Bring six, pick four. */
export const TEAM_SIZE = 6;
export const PICKED_TEAM_SIZE = 4;
export const ACTIVE_PER_SIDE = 2;
export const LEAD_COUNT = 2;

/** Champions "Stat Points" limits (sim/dex-formats.ts:348-350, team-validator.ts:1306-1310). */
export const STAT_POINT_TOTAL_LIMIT = 66;
export const STAT_POINT_PER_STAT_LIMIT = 32;
export const MAX_MOVES = 4;
export const LEVEL = 50;

/** Seconds Showdown waits between games before auto-starting the next one. */
export const BEST_OF_IN_BETWEEN_SECONDS = 40;

/** Special mechanics: only Mega Evolution exists in the champions mod. */
export const SPECIAL_MECHANICS = ['mega'] as const;
export type SpecialMechanic = (typeof SPECIAL_MECHANICS)[number];
