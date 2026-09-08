import { unpackTeam } from './PackedTeam';
import { RoomMessage } from '../showdown/protocol';
import { NameResolver, plainNameResolver } from './dex';

/**
 * What Showdown's `showOpenTeamSheets()` (sim/battle.ts:3184-3224) reveals for
 * the champions mod. See ARCHITECTURE.md §5. Anything else that might appear in
 * the packed string is intentionally dropped.
 */
export interface TeamSheetPokemon {
  /** 1-based original team slot (the order used in `|poke|` and team preview). */
  slot: number;
  species: string;
  speciesId: string;
  /** Forme suffix if any (e.g. "Rapid-Strike" for Urshifu-Rapid-Strike). */
  form: string | null;
  item: string;
  itemId: string;
  ability: string;
  abilityId: string;
  moves: string[];
  moveIds: string[];
  /** Nature is revealed on Champions team sheets (sim/battle.ts:3195). */
  nature: string | null;
  gender: string | null;
  level: number;
  /** Format-specific extras that the sheet legitimately shows. */
  specialMechanicInformation: {
    /** Hidden Power type, only present if the set carries Hidden Power. */
    hiddenPowerType?: string;
    /** Tera type if the server ever includes one (never for champions). */
    teraType?: string;
    /** Gigantamax flag (gen 8 only). */
    gigantamax?: boolean;
  };
}

export interface TeamSheet {
  side: 'p1' | 'p2';
  playerName?: string;
  pokemon: TeamSheetPokemon[];
  /** The raw packed sheet exactly as received (for logs/audits). */
  rawPacked: string;
}

export class OpenTeamSheetParser {
  constructor(private readonly names: NameResolver = plainNameResolver) {}

  /** Returns a sheet if `msg` is a `|showteam|SIDE|PACKED` line. */
  parseMessage(msg: RoomMessage): TeamSheet | null {
    if (msg.type !== 'showteam') return null;
    const side = msg.args[0] as 'p1' | 'p2';
    const packed = msg.rest.slice(side.length + 1);
    return this.parsePacked(side, packed);
  }

  parsePacked(side: 'p1' | 'p2', packed: string): TeamSheet {
    const sets = unpackTeam(packed);
    const pokemon: TeamSheetPokemon[] = sets.map((set, i) => {
      const species = this.names.species(set.species);
      const dash = species.indexOf('-');
      return {
        slot: i + 1,
        species,
        speciesId: set.speciesId,
        form: dash > 0 ? species.slice(dash + 1) : null,
        item: this.names.item(set.item),
        itemId: set.item,
        ability: this.names.ability(set.ability),
        abilityId: set.ability,
        moves: set.moves.map((m) => this.names.move(m)),
        moveIds: set.moves,
        nature: set.nature || null,
        gender: set.gender || null,
        level: set.level,
        specialMechanicInformation: {
          ...(set.hpType ? { hiddenPowerType: set.hpType } : {}),
          ...(set.teraType ? { teraType: set.teraType } : {}),
          ...(set.gigantamax ? { gigantamax: true } : {}),
        },
      };
    });
    return { side, pokemon, rawPacked: packed };
  }
}
