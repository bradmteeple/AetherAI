# AetherAI

A VGC team builder and doubles battle simulator for Generation IX, running on
the official Pokémon Showdown engine — vendored into this repository, so the
dex, the learnsets, the validator and the battle engine are all local.

```bash
npm run setup      # build the vendored engine (once)
npm start          # http://127.0.0.1:3000
```

### Reaching it

The site is a server, not a folder of static files — the battle engine runs
inside it — so it needs something that runs Node. Three ways in, cheapest first:

| | Command | Who can reach it |
|---|---|---|
| This machine | `npm start` | just you, at `http://127.0.0.1:3000` |
| Your phone, same wifi | `npm run lan` | anything on your network, at the `http://192.168.x.x:3000` it prints |
| Anywhere | `npm run share` | anyone with the link |

`npm run share` opens a **Cloudflare Quick Tunnel** — no account, no signup, no
card — and prints something like:

```
┌──────────────────────────────────────────────────────────┐
│  Public link:  https://neat-words-here.trycloudflare.com │
│  This machine: http://127.0.0.1:3000                     │
│  This network: http://192.168.1.24:3000                  │
└──────────────────────────────────────────────────────────┘
```

`cloudflared` is downloaded into `.aether/bin` the first time if you do not
already have it. What you trade for the zero setup: the link lives only as long
as the command runs, it is a different address next time, your machine has to
stay awake, and **anyone with the link can use the site** — there is no login.
Cloudflare gives account-less tunnels no uptime guarantee either.

For an address that stays put, deploy it to anything that runs Node
continuously (Fly, Render, Railway, a VPS). That needs an account somewhere;
the tunnel does not.

### VGC only

Eight formats, in two different rule systems:

| | Classic regulations | Pokémon Champions |
|---|---|---|
| Formats | VGC 2025 Reg I, 2024 Reg G, 2023 Reg D, 2023 Reg C | VGC 2026 Reg M-B and M-C, each also as Bo3 |
| Species | 911 | 347, Mega Evolutions included |
| Spreads | EVs, 252 per stat, 510 total | **Stat Points**, 32 per stat, 66 total |

Both are doubles, level 50, bring 4 of 6. The builder reads all of that from
the format itself, so switching regulation re-scales the sliders, swaps the
species and item pools, and re-clamps any spread the old rules allowed.

| Page | What it does |
|---|---|
| `/` | Landing page. The counts on it are read from the engine at load, not typed in. |
| `/teams` | Team builder: every species, ability, item and legal move for the regulation, with natures, spreads and Tera type. Validates through Showdown's own `TeamValidator`, imports and exports Showdown paste format, and saves teams in your browser. |
| `/battle` | A doubles battle against AetherAI, resolved by Showdown's `BattleStream`: team preview, per-slot move targeting, Terastallization, and best-of-three sets played game after game with a running score. |

Nothing is mocked: when the builder says Great Tusk can't learn Hydro Pump, or
that a Champions stat stops at 32, that is the format's own rules talking.

### Layout

```
server/showdown.js     formats, dex, learnsets and validation, straight from the engine
server/battles.js      live sessions; best-of-three is ours, the single game is the engine's
server/sample-teams.js two ready-made teams, validated per format before being offered
server/index.js        node:http server — static pages plus the JSON API
scripts/share.js       `npm run share` — the site on a public Cloudflare Quick Tunnel link
public/assets/targeting.js   doubles targeting, ported from the engine and shared with the tests
public/                the three pages; no framework, no build step, no CDN
test/                  node:test coverage of formats, both stat systems, targeting and full battles
vendor/pokemon-showdown/     the engine itself (see below)
```

API: `GET /api/formats`, `GET /api/dex`, `GET /api/moves?species=`,
`GET /api/movedex`, `GET /api/sampleteams?format=`, `POST /api/validate`,
`POST /api/battle`, `POST /api/battle/:id/choose`.

### Known limits

* The opponent is Showdown's `RandomPlayerAI` — it plays legal moves, not good
  ones — and it mirrors your team, so both sides bring the same six.
* The 2023 regulations have no sample team; build one in the builder.
* Best-of-three keeps the set score but does not carry Open Team Sheets or
  between-game switching restrictions across games.
* Battle sessions live in memory and expire after 30 minutes.
* There is no login: anyone who can reach the site can use it. Fine on your own
  machine or wifi; worth remembering before you hand the public link around.

## Vendored: Pokémon Showdown

The official [Pokémon Showdown](https://github.com/smogon/pokemon-showdown)
server and battle simulator is included in this repository at
`vendor/pokemon-showdown/`, so its simulator, dex data and server can be used
directly without a separate checkout.

| | |
|---|---|
| Upstream | https://github.com/smogon/pokemon-showdown |
| Commit | `a21fdb77ce43429c585c46b050837f2d59711717` |
| Date | 2026-09-19 |
| License | MIT — see `vendor/pokemon-showdown/LICENSE` |

It is a plain copy of the 1057 files upstream tracks, not a submodule: clone
this repository and it is simply there.

### Build it once

```bash
cd vendor/pokemon-showdown
npm install
node build                  # writes dist/ ; also creates config/config.js
```

`node_modules/`, `dist/` and `config/config.js` are build/local artifacts and
stay out of git.

### Use the simulator

```js
const { Dex, Teams, BattleStream } = require('./vendor/pokemon-showdown/dist/sim');

Dex.species.get('Flutter Mane').types;      // [ 'Ghost', 'Fairy' ]
Dex.formats.get('gen9vgc2025regg').name;    // format lookup
Teams.generate('gen9randombattle');         // a legal random team
```

### Run a local server

```bash
cd vendor/pokemon-showdown
node pokemon-showdown start 8000 --no-security
# http://localhost:8000  — ws://localhost:8000/showdown/websocket
```

`--no-security` skips the login server, which is what you want for local
testing against your own bots.

### Other entry points

```bash
node pokemon-showdown help             # every subcommand
node pokemon-showdown validate-team gen9vgc2025regg < team.txt
node pokemon-showdown simulate-battle  # battle over stdin/stdout
```

### Updating the copy

Re-copy the files upstream tracks at the ref you want, then commit the diff:

```bash
git clone --depth 1 https://github.com/smogon/pokemon-showdown.git /tmp/ps
rm -rf vendor/pokemon-showdown
(cd /tmp/ps && tar --exclude=./.git -cf - .) | (mkdir -p vendor/pokemon-showdown && tar -xf - -C vendor/pokemon-showdown)
(cd /tmp/ps && git ls-files -z) | sed -z 's|^|vendor/pokemon-showdown/|' | xargs -0 git add --force --
```

The `--force` matters: Showdown's own `.gitignore` covers paths it nonetheless
tracks (`config/config-example.js` among them), which a plain `git add` would
silently skip.
