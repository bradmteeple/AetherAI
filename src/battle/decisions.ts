/**
 * Structured decisions returned by a BattleAgent. The agent never sends raw
 * Showdown commands; the connector validates these against `LegalActions` and
 * encodes them itself.
 */

/** Team Preview: 1-based original team slots. First two lead, last two are the back. */
export interface TeamPreviewDecision {
  lead1: number;
  lead2: number;
  back1: number;
  back2: number;
  /** Optional free-text reasoning; recorded, never sent to the server. */
  reasoning?: string;
}

export type SlotAction =
  | {
      type: 'move';
      /** 1-based move slot as listed in `LegalMove.index`. */
      moveIndex: number;
      /** Target location (+1/+2 foes, -1/-2 allies); required iff the move `requiresTarget`. */
      target?: number;
      /** Mega Evolve this turn (only if `canMegaEvo`). */
      mega?: boolean;
    }
  | {
      type: 'switch';
      /** 1-based current team slot to switch to, as listed in `LegalSwitch.slot`. */
      toSlot: number;
    }
  | { type: 'pass' };

export interface TurnDecision {
  /** One action per active slot, in slot order (a, b). */
  actions: SlotAction[];
  /** Forfeit the current *game* (never the set). */
  forfeit?: boolean;
  reasoning?: string;
}
