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

### Web control panel

```bash
npm run control                 # http://127.0.0.1:8080  (this machine only)
npm run share                   # https://….trycloudflare.com  (public, no account)
npm run build:pages             # the same page as a static site for GitHub Pages
```

A small built-in web page to turn the bot on and off and choose which Showdown
account it logs in as — no `.env` edit, no restart:

* **Power** — one switch. On connects and logs in as the selected account and
  keeps playing sets until you switch it off; off abandons whatever set is in
  progress and drops the connection. If the login fails, the panel says so and
  the bot stays off.
* **Account** — save any number of Showdown logins (username + optional
  password) and pick the active one. Switching accounts requires the bot to be
  off, so a set is never half-played by two identities.
* **Settings** — mode (challenge/accept), opponent, agent (`mock`/`http` + URL),
  team file, format, server and login URLs, timer, whether to keep playing sets
  after each one, log level.
* **Status and log** — connection state, current set/score, win-loss record and
  a live tail of the connector's log.

Accounts and settings live in `.aether/control.json` (owner-only, gitignored).
Passwords are only ever sent *to* the server: the API returns `hasPassword`,
never the password itself.

The panel can start battles with your credentials, so it binds to `127.0.0.1`
and needs no password there. Set `CONTROL_PASSWORD` and it shows a sign-in
screen instead — required for any deployment that is reachable from elsewhere:

```bash
CONTROL_PASSWORD='a long random password' npx tsx src/cli.ts control --host 0.0.0.0
```

| Variable | Default | Meaning |
|---|---|---|
| `CONTROL_HOST` | `127.0.0.1` | Bind address |
| `CONTROL_PORT` | `8080` | Port |
| `CONTROL_PASSWORD` | — | Sign-in password for the browser. Sessions are a signed `HttpOnly` cookie valid for 14 days; changing the password signs everyone out |
| `CONTROL_TOKEN` | — | Shared secret for scripts (`Authorization: Bearer …` or `?token=`). Auto-generated if the panel would otherwise be reachable off-machine with no password |
| `CONTROL_ALLOWED_ORIGINS` | `https://*.github.io` | Browser origins allowed to call the API cross-origin (comma separated; `*` for any) |
| `CONTROL_STATE_FILE` | `.aether/control.json` | Where accounts and settings are stored |

The `.env` values are only the *defaults* the panel starts from — once saved,
`.aether/control.json` wins, and `PS_USERNAME`/`PS_PASSWORD` are adopted as the
first account on first run.

### A permanent link on GitHub Pages

GitHub Pages serves static files, so it cannot run the bot — the bot holds a
WebSocket to Showdown and needs a real process. What it *can* host, for free
and forever at a URL that never changes, is the **panel itself**, pointed at
wherever your bot is running:

```
https://<owner>.github.io/<repo>/          the page  (GitHub Pages, permanent)
        ↓  you paste the address once, the browser remembers it
https://….trycloudflare.com                the bot   (npm run share, your machine)
```

Enable it once: **Settings → Pages → Source: GitHub Actions**. The workflow in
`.github/workflows/pages.yml` publishes `scripts/build-pages.ts`' output on
every push that touches the page.

Then bookmark the Pages URL. The first visit asks for the bot's address; after
that it goes straight to the sign-in screen. When your tunnel URL changes, hit
**Change bot** and paste the new one — the bookmark itself never changes.

The standalone page authenticates with a bearer token in `localStorage` rather
than a cookie, so there are no cross-site cookies and nothing for another site
to ride on. The bot only answers browsers from origins in
`CONTROL_ALLOWED_ORIGINS`, which defaults to `https://*.github.io`; set it to
your exact Pages origin to narrow that, or to `*` to allow any.

### A public URL for the bot, with no hosting account

```bash
npm run share
```

Starts the panel and opens a **Cloudflare Quick Tunnel** to it — no account, no
signup, no card:

```
┌─────────────────────────────────────────────────────────────────┐
│  Control panel:  https://neatly-picked-words.trycloudflare.com  │
│  Password:       TNfiXmv9jiyb                                   │
└─────────────────────────────────────────────────────────────────┘
```

That address works from any browser anywhere. `cloudflared` is downloaded into
`.aether/bin` the first time if it is not already installed.

What you are trading away for the zero-setup:

* **It lasts as long as the command runs.** Close it and the URL is dead; the
  next run gets a different address. Your machine has to stay awake.
* A password is generated for you each run — pass `CONTROL_PASSWORD` to fix it,
  or `npm run share -- --open` to publish with no password at all (then anyone
  with the link can turn the bot on and off).
* Cloudflare rate limits and does not guarantee uptime for account-less
  tunnels.

For an address that stays put, deploy it properly:

### A permanent URL (Fly.io, or any Docker host)

The panel is not a static site: the bot runs *inside* the same process and
holds a WebSocket to Showdown for as long as it is on, so it needs a host that
runs a Node process continuously — Vercel/Netlify/Pages cannot serve this. The
included `Dockerfile` and `fly.toml` do it on Fly.io, with a volume for
accounts and set records:

```bash
fly launch --no-deploy --copy-config      # choose an app name and region
fly volumes create aether_data --size 1   # accounts, settings, runs/
fly secrets set CONTROL_PASSWORD="$(openssl rand -base64 24)"
fly deploy
```

The panel is then at `https://<app>.fly.dev`, behind the sign-in screen, and
you can turn the bot on and off from any browser. Notes on the config:

* `auto_stop_machines = false` and `min_machines_running = 1` — Fly must not
  scale the machine to zero underneath a live battle.
* One machine only. Two would each try to log the same Showdown account in.
* `/data` holds `control.json` (mode 0600) and `runs/`, so accounts, settings
  and set records survive deploys and restarts.
* `force_https = true`, and the session cookie is marked `Secure` when the
  request arrives over HTTPS (via `x-forwarded-proto`).
* Failed sign-ins are rate limited per client address with an exponential
  lockout, keyed off `fly-client-ip`.

Fly needs an account (free tier, card on file). Render, Railway, Koyeb and any
VPS take the same image — the Dockerfile is plain Docker:

```bash
docker build -t aetherai .
docker run -p 8080:8080 -e CONTROL_PASSWORD=... -v aether:/data aetherai
```

Two things worth being deliberate about before putting it online: the machine
holds your Showdown password, and the bot plays under your account, so use a
long `CONTROL_PASSWORD` and check that a bot account is acceptable wherever you
point it.

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
src/control/       ControlStore (accounts/settings), BotRunner (on/off), Auth (login), HTTP API + control panel page
scripts/share.ts   `npm run share` — the panel on a public Cloudflare Quick Tunnel URL
scripts/build-pages.ts  `npm run build:pages` — the panel as a static site for GitHub Pages
src/recording/     SetRecorder (runs/set_*/...)
tests/unit         protocol, team, legal actions, set manager, state engine, control panel
tests/integration  full Bo3 sets against a local Showdown server
```

## Fair play

The agent only ever sees what a human player sees in the official client: its
own team, the opponent's open team sheet (species, item, ability, moves,
nature, gender, level — never stat points/IVs), public battle events, and
previous games of the same set. Legal actions are derived from our own
`|request|`; nothing is read from server internals or the opponent's requests.
