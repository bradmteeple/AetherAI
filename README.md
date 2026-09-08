# AetherAI — Showdown connector for `[Gen 9 Champions] VGC 2026 Reg M-B (Bo3)`

A production-oriented bridge between the **official Pokémon Showdown server**
and an **external battle agent**, purpose-built for the native best-of-three,
force-open-team-sheet Regulation M-B format (`gen9championsvgc2026regmbbo3`).

It handles everything except the battle intelligence: connection and login,
team validation, challenges, the best-of-three parent room, open team sheets,
team preview, per-turn legal actions, action validation/encoding, automatic
`/confirmready` between games, cross-game memory, and one coherent record per
set. The agent is a small provider-independent interface (`BattleAgent`) —
plug in an LLM, a search algorithm, a learned policy, or a mock.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) first: it documents every Showdown
protocol fact the connector relies on, each verified against the current
server source with file/line references.

## Quick start

```bash
npm install
cp .env.example .env            # fill in PS_USERNAME / PS_PASSWORD / PS_OPPONENT
npm run validate-team           # static + (if available) exact champions validation
npm run play                    # challenge PS_OPPONENT to a Reg M-B Bo3 with the mock agent
```

`npm run play` connects to `wss://sim3.psim.us/showdown/websocket`, logs in,
validates `teams/regmb-team.txt` with the server's own validator (`/vtm`),
sends the challenge, and then plays the whole set with the configured agent.
Use `PS_MODE=accept` to wait for a challenge instead. Everything about the set
is written to `runs/set_<date>_<n>/`.

### Local end-to-end testing (recommended before the public server)

```bash
npm run setup:showdown          # clones + builds smogon/pokemon-showdown into .showdown/
npm test                        # unit tests
npm run test:integration        # starts a local server and plays real Bo3 sets bot-vs-bot
npm run verify:showdown         # re-checks the protocol facts in ARCHITECTURE.md
```

The integration suite covers the acceptance path end to end on a real server:
team validation, challenge/accept, parent-room and game-room detection, forced
OTS parsing, team preview, full games with random legal actions, game-end vs
set-end detection, automatic `/confirmready`, game 2/3 room creation, set
memory preservation, 2-0 and 2-1 sets, reconnection mid-set (log replay),
malformed agent output (retry → fallback), forced switches, doubles targeting,
and the HTTP agent contract.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PS_SERVER_URL` | `wss://sim3.psim.us/showdown/websocket` | WebSocket endpoint (`ws://localhost:8000/showdown/websocket` for a local server) |
| `PS_LOGIN_URL` | `https://play.pokemonshowdown.com/api/` | Login API base |
| `PS_USERNAME`, `PS_PASSWORD` | — | Bot account (password optional for unregistered names) |
| `PS_NO_LOGIN_SERVER` | auto (`true` for localhost) | Skip the HTTP login (local `--no-security` servers) |
| `PS_FORMAT` | `gen9championsvgc2026regmbbo3` | Format id |
| `PS_TEAM_FILE` | `teams/regmb-team.txt` | Team in Showdown export format (EVs = Champions Stat Points) |
| `PS_MODE` | `challenge` | `challenge` or `accept` |
| `PS_OPPONENT` | — | Who to challenge / accept from |
| `AGENT`, `AGENT_URL` | `mock` | `mock` or `http` (+ base URL) |
| `PS_TIMER` | `true` | Send `/timer on` in every game (VGC timer) |
| `PS_READY_DELAY_MS` | `1500` | Delay before `/confirmready` between games |
| `AGENT_TIMEOUT_MS` | `45000` | Per-call agent timeout (VGC gives 55 s per turn; the driver allows one retry) |
| `RUNS_DIR` | `runs` | Where set records go |
| `LOG_LEVEL` | `info` | `debug` to see every protocol frame |

## Plugging in an external agent

Implement `BattleAgent` (`src/agent/BattleAgent.ts`):

```ts
interface BattleAgent {
  chooseTeamPreview(input: TeamPreviewInput): Promise<TeamPreviewDecision>; // {lead1, lead2, back1, back2}
  chooseTurn(input: TurnDecisionInput): Promise<TurnDecision>;               // {actions: [slotA, slotB]}
  onGameEnd?(record, score, memory): Promise<void>;
  onSetEnd?(score, result): Promise<void>;
}
```

Inputs carry: format, game number, **set score**, our full team, the
opponent's **Open Team Sheet**, the current public battle state, our bring-four,
the opponent's revealed bring, `OpponentBattleKnowledge` (what this game has
revealed), **`previousGames`/`setMemory`** (structured turn history, speed
orders, damage results, switches, Protects, targeting, KOs, tendencies), the
exact **legal actions** derived from the server's `|request|`, and an optional
`strategicContext` slot for guides. Decisions are validated against the legal
actions; an invalid decision is returned to the agent once with the errors,
and a safe legal fallback is used if it fails again. The agent never sends raw
Showdown commands.

Out of the box:

* `MockBattleAgent` — random legal play that rotates its bring-four per game.
* `HttpBattleAgent` — POSTs the inputs as JSON to `/team-preview` and `/turn`
  (see `examples/agent-server.ts`, `npm run agent-server`).

## Layout

```
src/showdown/      ShowdownConnection, LoginClient, protocol parser, ProtocolRouter, ChallengeManager
src/team/          packed format, team file loader, OpenTeamSheetParser, validators, optional Dex bridge
src/battle/        request types, BattleStateEngine, LegalActionGenerator, ActionValidator, ActionEncoder, ObservationTracker
src/set/           SetState/GameRecord, SetMemory, BestOfSetManager (state machine)
src/agent/         BattleAgent interface, MockBattleAgent, HttpBattleAgent, AgentDriver (retry/fallback)
src/orchestration/ GameSession (one game), SetOrchestrator (one set)
src/recording/     SetRecorder (runs/set_*/...)
tests/unit         protocol, team, legal actions, set manager, state engine
tests/integration  full Bo3 sets against a local Showdown server
```

## Fair play

The agent only ever sees what a human player sees in the official client: its
own team, the opponent's open team sheet (species, item, ability, moves,
nature, gender, level — never stat points/IVs), public battle events, and
previous games of the same set. Legal actions are derived from our own
`|request|`; nothing is read from server internals or the opponent's requests.
