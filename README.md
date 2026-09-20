# AetherAI

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
