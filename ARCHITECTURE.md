# AetherAI Showdown Connector — Architecture

This document records what the **current Pokémon Showdown source** does for the
`[Gen 9 Champions] VGC 2026 Reg M-B (Bo3)` format, and how this connector is
built on top of it. Every protocol claim below was verified against the
`smogon/pokemon-showdown` repository at commit
`6b4bc34e44cc2541929cc4b8fff96e756ab3f268` (2026-09-06). File references are
to that checkout. Re-verify these when Showdown updates; `npm run verify:showdown`
re-checks the most fragile facts against a checkout in `.showdown/`.

---

## 1. Format identity

`config/formats.ts:310-314`

```ts
{
  name: "[Gen 9 Champions] VGC 2026 Reg M-B (Bo3)",
  mod: 'champions',
  gameType: 'doubles',
  ruleset: ['Flat Rules', 'VGC Timer', 'Force Open Team Sheets', 'Best of = 3'],
}
```

* **Format ID** = `toID(name)` = **`gen9championsvgc2026regmbbo3`**.
  (The non-Bo3 sibling is `gen9championsvgc2026regmb`; it has `bestOfDefault: true`
  and uses *optional* `Open Team Sheets`, which is NOT what we want.)
* `Flat Rules` is overridden by the champions mod (`data/mods/champions/rulesets.ts:26-31`):
  `Obtainable, Team Preview, Species Clause, Nickname Clause, Item Clause = 1,
  Adjust Level = 50, Picked Team Size = Auto, Min Team Size = 6, Cancel Mod`;
  banlist `Mythical`, `Restricted Legendary`.
* `Picked Team Size = Auto` resolves to **4** for doubles (`sim/dex-formats.ts:336-341`).
  `Min Team Size = 6` → bring six, pick four.
* `VGC Timer` (`data/rulesets.ts:778-787`): `Timer Starting = 420`, `Timer Grace = 90`,
  `Timer Add Per Turn = 0`, `Timer Max Per Turn = 55`, `Timer Max First Turn = 90`,
  `Timeout Auto Choose`, `DC Timer Bank`. The timer only runs once a player sends
  `/timer on` (or the server forces it) — `server/room-battle.ts:605-606`.
* `Best of = 3` (`data/rulesets.ts:2906-2921`) is a value rule read by
  `Rooms.createBattle` and `BestOfGame`.

### Champions mod mechanics that differ from Scarlet/Violet (`data/mods/champions/`)

| Topic | Champions behaviour | Source |
|---|---|---|
| Generation | `gen: 9` (protocol sends `|gen|9`) | `scripts.ts:2` |
| Terastallization | **Not available** — `actions.canTerastallize()` returns `null`; validator deletes `teraType`; requests omit `teraType`/`terastallized` | `scripts.ts:180-182`, `sim/team-validator.ts:713-724`, `sim/pokemon.ts:1188-1191` |
| Mega Evolution | Available via Mega Stones (`isNonstandard: null` on stones); request field `canMegaEvo`; choice suffix ` mega`. Megas persist after fainting. | `items.ts`, `scripts.ts:183-194`, `sim/pokemon.ts:1140-1143` |
| Stats | "Stat Points" instead of EVs: `stat = base + points + 20` (HP: `+75`), natures ×1.1/×0.9, all IVs must be 31 | `scripts.ts:10-40`, `sim/team-validator.ts:1148-1160` |
| Stat point limits | **66 total**, **max 32 per stat** | `sim/dex-formats.ts:348-350`, `sim/team-validator.ts:1306-1310` |
| PP | Every move's PP capped at 20; PP-up formula `(pp/5+1)*4` | `scripts.ts:3-9, 41-43` |
| Paralysis | 1/8 full-para chance (SV: 1/4) | `conditions.ts:2-10` |
| Sleep | 2–3 turns, sampled `[2,3,3]` | `conditions.ts:11-30` |
| Freeze | Thaws within 3 turns (counter) or 1/4 chance | `conditions.ts:31-56` |
| Trick Room | Speed is negated (no underflow trick) | `scripts.ts:45-53` |
| Level | Adjust Level = 50 (not "Down") | `rulesets.ts:29` |

The connector never hard-codes SV-only mechanics; every "special mechanic" is
driven by flags in the `|request|` JSON (`canMegaEvo`, `canMegaEvoX/Y`,
`canTerastallize`, `canDynamax`, `canZMove`). In this format only `canMegaEvo`
will appear.

---

## 2. Authentication flow

`PROTOCOL.md` (`|challstr|`), `server/chat-commands/core.ts:1709-1716` (`/trn`),
`server/users.ts:634-702` (`validateToken`), `server/users.ts:969` (`|updateuser|`).

1. Open a raw WebSocket to `wss://sim3.psim.us/showdown/websocket`
   (official) or `ws://localhost:8000/showdown/websocket` (local).
   Frames are plain text; no SockJS framing.
2. The server sends `|challstr|KEYID|CHALLENGE` (the whole string after
   `|challstr|`, pipes included, is the challstr).
3. Registered account: `POST https://play.pokemonshowdown.com/api/login`
   with form body `name=USER&pass=PASS&challstr=CHALLSTR`. The response is
   `]` + JSON; use `data.assertion`. An assertion starting with `;` is an error
   (`;;message`).
   Unregistered name: `GET https://play.pokemonshowdown.com/api/getassertion?userid=ID&challstr=CHALLSTR`
   returns the raw assertion text (or `;;error`).
4. Send `|/trn USERNAME,0,ASSERTION`.
5. Success: `|updateuser|USER|1|AVATAR|SETTINGS` (NAMED = `1`).
   Failure: `|nametaken|USERNAME|MESSAGE`.
6. Local test servers started with `--no-security` set
   `Config.noguestsecurity` (`server/config-loader.ts:33-35`), which makes
   `/trn USERNAME,0,` with an **empty token** succeed for non-trusted names
   (`server/users.ts:635-641`).

After login the server sends `|updatesearch|{"searching":[],"games":{roomid:title}|null}`
listing every game room the user is a player in (best-of parents included) —
`server/ladders.ts:274-292`. The connector uses this on reconnect to rediscover
the set rooms.

---

## 3. Challenges (`|updatechallenges|` no longer exists)

`server/ladders-challenges.ts:217-236`, `server/chat-commands/core.ts:1516-1535,1601-1620`, `PROTOCOL.md`.

* Set team first: `|/utm PACKEDTEAM` (`core.ts:1653-1656`). The team must be
  in packed format (`sim/TEAMS.md`).
* Challenge: `|/challenge USERNAME, gen9championsvgc2026regmbbo3`.
* Incoming/outgoing challenge state is delivered **as a PM**, not as
  `|updatechallenges|` (that message is gone from the server):

  ```
  |pm| Challenger| Challenged|/challenge FORMATID|TEAMBUILDERFORMATID|MESSAGE|ACCEPTBUTTON|REJECTBUTTON
  ```
  and a bare `|pm|A|B|/challenge` when a challenge is cancelled/consumed
  (`getUpdate()`, `ladders-challenges.ts:217-221`).
* Accept: `|/utm PACKEDTEAM` then `|/accept USERNAME`. Reject: `|/reject USERNAME`.
  Cancel own: `|/cancelchallenge USERNAME`.
* Team validation errors arrive as `|popup|...` and the challenge is not sent.
* Explicit validation without challenging: `|/vtm gen9championsvgc2026regmbbo3`
  → `|popup|Your team is valid for [Gen 9 Champions] VGC 2026 Reg M-B (Bo3).`
  or `|popup|Your team was rejected for the following reasons:||- ...`
  (`core.ts:1659-1677`). The connector uses this as the authoritative
  pre-set validation against whichever server it is connected to.

---

## 4. Best-of parent room and sub-battle rooms

`server/rooms.ts:2191-2290` (`createBattle`), `server/room-battle-bestof.ts`.

When a `Best of = N` challenge is accepted:

1. `createBattle` creates the **parent room** with id
   `game-bestof3-gen9championsvgc2026regmbbo3-<N>` and title `P1 vs. P2`,
   game class `BestOfGame`. Both players are auto-joined (`p.joinRoom(room)`),
   so the client receives `>game-bestof3-...` / `|init|battle` / `|title|...`.
   `BestOfGame.onConnect` sends `|cantleave|` — do not leave this room.
2. On the next tick `BestOfGame.nextGame()` calls `createBattle` with
   `isBestOfSubBattle: true`, producing a normal battle room
   `battle-gen9championsvgc2026regmbbo3-<M>` (both players auto-joined).
   `battleRoom.rated` is zeroed; the timer is started in the sub-battle only if
   `/timer on` was used in the parent (`needsTimer`).
3. Linking messages (`room-battle-bestof.ts:224-247`):
   * in the **sub-battle**:
     `|html|<table ...>P1 ... P2 ... (win dots)</table>` and
     `|uhtml|bestof|<h2><strong>Game N</strong> of <a href="/game-bestof3-...">a best-of-3</a></h2>`
   * in the **parent**:
     `|html|<h2>Game N</h2>` then `|uhtml|gameN|<a href="/battle-...">TITLE</a>`
     plus `|fieldhtml|` / `|controlshtml|` progress displays.
   * in the **previous sub-battle** (games ≥ 2):
     `|uhtml|next|Next: <a href="/battle-..."><strong>Game N of 3</strong></a>`

The connector identifies the parent by room-id prefix `game-bestof`, identifies
sub-battles by prefix `battle-`, and links them using **either** the
`|uhtml|bestof|` line inside the battle room **or** the `|uhtml|gameN|` line in
the parent — whichever arrives first. The game number comes from the same lines
(and is cross-checked against the number of games seen so far).

### Game end inside the set (`onBattleWin`, `room-battle-bestof.ts:334-355`)

Each sub-battle ends with the usual `|win|NAME` (or `|tie`). `RoomBattle.end()`
then calls `parent.game.onBattleWin()`, which:

* records the winner, increments `wins`, and posts
  `|html|NAME won game N!` (or `|html|Game N was a tie.`) in the **parent**;
* if a player reached the win threshold (2) → `end()` → **set complete**:
  parent posts `|allowleave|`, then `|win|NAME` (or `|tie`);
* otherwise → `promptNextGame()` → **between-games ready state**.

Sub-battle `|win|` therefore always precedes the parent's messages; the parent's
`|win|`/`|tie` is the authoritative set-completion signal. The connector also
keeps its own score and asserts they agree.

### Between-games ready state (`promptNextGame`, `updateReadyButton`)

For each player (`ready = false`), `updateReadyButton()` sends:

* `|tempnotify|choice|Next game|It's time for game N in your best-of-3!`
  (to the finished battle room if the player is in it, else to the parent);
* to **both** the parent and the finished battle room:
  ```
  |c|~|/uhtml controls,<div class="infobox"><p ...>Are you ready for game N, NAME?</p><p ...><button class="button notifying" name="send" value="/msgroom game-bestof3-...-<N>,/confirmready">I'm ready!</button></p></div>
  ```
* every 10 s while waiting: `|inactive|NAME has Xs to confirm battle start!`
  in both rooms (`pokeNextBattleTimer`). After **40 s**
  (`BEST_OF_IN_BETWEEN_TIME`) the next game starts automatically. A player
  whose disconnect bank runs out during the wait forfeits the series.

### `/confirmready` (`core.ts:963-966`, `room-battle-bestof.ts:395-411`)

* Must be executed **in the parent room** (`this.requireGame(Rooms.BestOfGame)`).
  Send `game-bestof3-...-<N>|/confirmready` (or the equivalent the button uses:
  `|/msgroom game-bestof3-...-<N>,/confirmready`).
* Errors: "You aren't a player in this best-of set." /
  "The battle is not currently waiting for ready confirmation."
* Success posts `||NAME is ready for game N.` to both rooms and re-renders the
  button as disabled ("waiting for opponent..."). When **both** players are
  ready, `nextGame()` runs immediately and the new sub-battle room is created
  and auto-joined as in step 2 above.

### Reconnection during a set

`RoomBattle.onConnect` (`room-battle.ts:934-953`) re-sends the pending
`|request|` (and `|sentchoice|` if a choice was already made) when a player
re-joins a battle room; `BestOfGame.onConnect` re-sends `|cantleave|` and the
ready button. After re-login the connector rejoins the parent and the current
sub-battle with `|/join ROOMID` using the ids from `|updatesearch|`.

---

## 5. Open Team Sheets delivery

`data/rulesets.ts:2001-2014` (`Force Open Team Sheets`), `sim/battle.ts:3184-3224` (`showOpenTeamSheets`), `sim/battle.ts:1977-1990` (`runPickTeam`).

* `runPickTeam()` calls every rule's `onTeamPreview` in rule-table order.
  `Team Preview` (inside Flat Rules) runs first and emits
  `|clearpoke`, `|poke|pX|DETAILS|item`, `|teampreview|4`; then
  `Force Open Team Sheets` runs `showOpenTeamSheets()` unconditionally
  (no accept/deny button exchange — that only exists for the optional rule).
* The sheets are emitted **publicly** via `this.add('showteam', side.id, Teams.pack(team))`,
  i.e. a battle-log line

  ```
  |showteam|p1|PACKEDTEAM
  |showteam|p2|PACKEDTEAM
  ```

  delivered to both players and spectators, before the `|request|` for team
  preview arrives. (`|request|` follows the log update: `sendUpdates`,
  `sim/battle.ts:3267-3273`, and `server/room-battle.ts:772-811`.)

### Fields exposed on the sheet (per Pokémon)

`showOpenTeamSheets` builds a `PokemonSet` with exactly:

| Field | Value | Notes |
|---|---|---|
| `name` | `''` | nicknames hidden |
| `species` | full species incl. forme | Zacian/Zamazenta holding their signature item shown as `-Crowned` and Iron Head rewritten to Behemoth Blade/Bash |
| `item` | item | |
| `ability` | ability | |
| `moves` | all moves | |
| `nature` | **revealed only when `format.mod` starts with `champions`** — so revealed in Reg M-B | `sim/battle.ts:3195` |
| `gender` | gender | |
| `level` | level (50) | |
| `evs`, `ivs` | `null` → packed as blank | hidden (stat points are never on the sheet) |
| `teraType` | added when gen 9 and no Terastal Clause, but champions sets have `teraType` deleted by the validator, so blank | |
| `hpType` | only if the set has Hidden Power | |
| `gigantamax` | gen 8 only | |

Not on the sheet: stat points, IVs, nickname, shininess, Poké Ball, happiness.
The connector's `OpenTeamSheetParser` decodes the packed string
(`sim/TEAMS.md` packed format:
`NICKNAME|SPECIES|ITEM|ABILITY|MOVES|NATURE|EVS|GENDER|IVS|SHINY|LEVEL|HAPPINESS,POKEBALL,HPTYPE,GMAX,DMAXLEVEL,TERATYPE`)
and exposes only the fields above; even if a future server leaks EVs in the
packed string, the parser drops them (fair-play guard).

Both players may still use `!showteam hidestats` (`core.ts:919-960`) which
renders HTML in chat; the connector ignores that path and relies on
`|showteam|`.

---

## 6. Team Preview request and choice

`sim/battle.ts:1391-1397, 1434-1439` and `sim/side.ts:1031-1095`.

* Log line `|teampreview|4` (the number is `pickedTeamSize`).
* Request JSON:

  ```json
  {"teamPreview":true,"maxChosenTeamSize":4,"side":{"name":"...","id":"p1","pokemon":[ ...6 entries... ]},"rqid":1}
  ```
  Each `side.pokemon` entry (`sim/pokemon.ts:1159-1193`): `ident`, `details`,
  `condition`, `active`, `stats` (atk/def/spa/spd/spe), `moves` (ids),
  `baseAbility`, `item`, `pokeball`, `ability`, `commanding`, `reviving`.
  No `teraType` in champions.
* Choice: `/choose team 3,1,5,2|RQID` — 1-based **original team-preview slot
  numbers**, exactly four. The **first two become the leads** (positions `a`
  and `b`), the last two are the back. Duplicates and out-of-range slots are
  rejected with `|error|[Invalid choice] Can't choose for Team Preview: ...`.
  Brackets (`team [3,1,5,2]`) disable auto-completion so short lists error
  instead of being padded.
* After both choices: `|start`, then `|switch|` lines for the leads and turn 1's
  `|turn|1` followed by the first move `|request|`.
* The `rqid` is assigned by the server (`room-battle.ts:797-801`) and should be
  echoed with `|RQID` on every `/choose`.

---

## 7. Doubles choice syntax (`sim/SIM-PROTOCOL.md`, `sim/side.ts:1200-1300`)

`/choose CHOICE_A, CHOICE_B|RQID` — one comma-separated choice per active slot,
in slot order (`a` then `b`).

| Choice | Syntax |
|---|---|
| move | `move <1-based slot or id> [<target>] [mega]` |
| switch | `switch <1-based team slot>` (post-preview order: slots 1–2 are the actives, 3–4 the back) |
| pass | `pass` (required for fainted / commanding slots; auto-inserted by the server if omitted) |
| default | `default` (server picks the first legal option) |
| forfeit | not a `/choose`; `/forfeit` in the battle room |

Targets (`validTargetLoc`, `sim/battle.ts:2399-2432`; `CHOOSABLE_TARGETS`,
`sim/battle-actions.ts:3`): a target number is required **only** when the move's
`target` is one of `normal`, `any`, `adjacentAlly`, `adjacentAllyOrSelf`,
`adjacentFoe`. `+1`/`+2` (or `1`/`2`) are foes, `-1`/`-2` allies. In doubles:

* `normal` / `any`: either foe; `any` also allows the ally; `normal` allows
  the *other* ally.
* `adjacentAlly`: the other ally only. `adjacentAllyOrSelf`: other ally or self
  (`-1` for slot a, `-2` for slot b). `adjacentFoe`: `+1` or `+2`.
* Spread/self/side/field moves (`allAdjacentFoes`, `allAdjacent`, `self`,
  `allySide`, `foeSide`, `all`, `allyTeam`, `randomNormal`, `scripted`) must be
  sent **without** a target or the server rejects the choice.

Switch rules (`chooseSwitch`, `sim/side.ts:915-1018`): cannot switch to an
active slot, a fainted Pokémon, or a Pokémon already chosen this turn
("can only switch in once"); `trapped: true` in the request forbids
switching; `maybeTrapped` means the server will reveal trapping only when a
switch is attempted (the choice then errors and a fresh `|request|` follows —
`|error|[Unavailable choice] ...` + `|request|`).

Force-switch requests (`forceSwitch: [bool, bool]`): send one `switch N` per
`true` slot in order; the server auto-passes `false` slots, and if fewer
healthy Pokémon remain than slots to fill, the extra slot must `pass`.

Mega Evolution: append ` mega` to the move of the Pokémon whose request has
`canMegaEvo: true`; at most one per battle (the server clears the flag).

Errors come as `|error|[Invalid choice] ...` (same request, re-choose) or
`|error|[Unavailable choice] ...` followed by an updated `|request|`
(`request.update = true`).

---

## 8. Set-completion messages (summary)

| Event | Room | Message |
|---|---|---|
| Game N ends | sub-battle | `|win|NAME` / `|tie` |
| Game result recorded | parent | `|html|NAME won game N!` / `|html|Game N was a tie.` |
| More games needed | both | `|tempnotify|choice|Next game|...`, `|c|~|/uhtml controls,...confirmready...`, then `|inactive|NAME has ... to confirm battle start!` every 10 s |
| Player confirms | both | `||NAME is ready for game N.` |
| Next game starts | new sub-battle | `|init|battle` + `|uhtml|bestof|<h2><strong>Game N</strong> of <a href="/game-bestof3-...">` ; parent `|uhtml|gameN|<a href="/battle-...">` ; previous battle `|uhtml|next|...` |
| Set decided | parent | `|allowleave|` then `|win|NAME` (or `|tie`) |
| Forfeit of the whole set | parent | `||NAME forfeited.` / `... lost the series due to inactivity.` then `|win|` |

A `/forfeit` sent **inside a sub-battle room** only forfeits that game
(`RoomBattle.forfeit`), and the set continues; `/forfeit` in the parent room
forfeits the series (`BestOfGame.forfeit`). The connector only ever forfeits a
game, never the set, and only when the agent explicitly returns a `forfeit`
decision.

---

## 9. Connector architecture

```
ShowdownConnection      raw WebSocket, login, reconnect, send queue, room tracking
        │
ProtocolRouter          splits ">room\n|type|args" frames, emits typed RoomMessage events
        │
BestOfSetManager        parent/sub-battle detection, score, ready confirmation, transitions
        │
OpenTeamSheetParser     |showteam| → TeamSheet (public fields only)
        │
BattleStateEngine       one per game: |request| + battle log → BattleState
        │
ObservationTracker      per-game public observations → GameRecord / SetMemory
        │
LegalActionGenerator    |request| → LegalActions (team preview / turn / force switch)
        │
BattleAgent (external)  chooseTeamPreview() / chooseTurn()  — provider independent
        │
ActionValidator         structured decision vs LegalActions (retry once, then fallback)
        │
ActionEncoder           decision → "/choose ...|rqid"
        │
ShowdownConnection
```

State is split into three strictly separated layers:

* **Team-sheet state** (`TeamSheet`): our team + opponent OTS. Built once per
  set from `|showteam|` (and re-parsed each game; the sheets are identical
  across games since the team is fixed for the set).
* **Game state** (`BattleState`): reset for every game. HP, status, boosts,
  actives, field, side conditions, volatiles, request, turn, revealed
  battle knowledge for the opponent (`OpponentBattleKnowledge`).
* **Set state** (`SetState`): persists across games. Score, current game,
  `GameRecord[]`, per-set opponent observations (`SetMemory`).

`BestOfSetManager` runs the state machine

```
WAITING → SET_CREATED → GAME_n_TEAM_PREVIEW → GAME_n_ACTIVE → GAME_n_COMPLETE
        → (BETWEEN_GAMES → READY_CONFIRMED → GAME_{n+1}_TEAM_PREVIEW ...) | SET_COMPLETE
```

Every decision the agent makes is recorded (`decisions.jsonl`) with the legal
actions offered, the decision returned, validation results, and the encoded
command. Records are written under `runs/set_<timestamp>_<n>/`.

### Fair-play boundary

The agent receives: our team, the opponent's OTS (public), the public battle
log-derived state, previous games of the same set, and legal actions derived
from our own `|request|`. It never receives raw protocol access, the
opponent's request, stat points, or anything not shown to a human player in
the official client.

---

## 10. Empirical verification

Beyond reading the source, the integration suite (`npm run test:integration`)
plays complete Bo3 sets bot-vs-bot on a locally built copy of the same
commit and records every protocol line (`runs/set_*/protocol.log`). A recorded
2-0 set showed exactly the sequence documented above:

```
battle-…-69   |clearpoke  |poke|p1|…  |poke|p2|…  |teampreview|4
battle-…-69   |showteam|p1|Incineroar||SitrusBerry|Intimidate|FakeOut,…|Careful||M|||50|]…
battle-…-69   |showteam|p2|…                       ← may arrive in a later frame; the connector waits for both
battle-…-69   |request|{"teamPreview":true,"maxChosenTeamSize":4,…,"rqid":2}
battle-…-69   |start … |turn|1 … |request|{"active":[…],"rqid":4}
battle-…-69   |win|aetherbot
battle-…-69   |tempnotify|choice|Next game|It's time for game 2 in your best-of-3!
game-bestof3-…-68  |c|~|/uhtml controls,…<button … value="/msgroom game-bestof3-…-68,/confirmready">I'm ready!</button>…
battle-…-69   |c|~|/uhtml controls,…                (same button)
game-bestof3-…-68  ||rivalbot is ready for game 2.   ||aetherbot is ready for game 2.
battle-…-70   |init|battle … |uhtml|bestof|<h2><strong>Game 2</strong> of <a href="/game-bestof3-…-68">a best-of-3</a></h2>
game-bestof3-…-68  |html|<h2>Game 2</h2>  |uhtml|game2|<a href="/battle-…-70">aetherbot vs. rivalbot</a>
battle-…-69   |uhtml|next|Next: <a href="/battle-…-70"><strong>Game 2 of 3</strong></a>
battle-…-70   |win|aetherbot
game-bestof3-…-68  |allowleave|   |win|aetherbot
```

`npm run verify:showdown` re-checks the source-level facts (format
definition, `/confirmready`, room-id conventions, OTS delivery, champions
mechanics) against the checkout so drift is caught before it breaks a set.
