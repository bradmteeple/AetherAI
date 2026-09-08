/**
 * Re-verifies the Showdown facts ARCHITECTURE.md relies on against a local
 * checkout (.showdown or SHOWDOWN_DIR). Exits non-zero if anything drifted.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { candidateShowdownDirs, loadShowdown } from '../src/team/dex';
import { FORMAT_ID, FORMAT_NAME, FORMAT_MOD, FORMAT_GAME_TYPE, FORMAT_RULESET, PICKED_TEAM_SIZE, STAT_POINT_TOTAL_LIMIT } from '../src/format';

const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
};

const dir = candidateShowdownDirs().find((d) => existsSync(resolve(d, 'server/room-battle-bestof.ts')));
if (!dir) {
  console.error('No Showdown checkout found. Run `npm run setup:showdown` first.');
  process.exit(2);
}
const read = (p: string) => readFileSync(resolve(dir, p), 'utf8');

const formats = read('config/formats.ts');
check(formats.includes(`name: "${FORMAT_NAME}"`), `config/formats.ts defines ${FORMAT_NAME}`);
const block = formats.slice(formats.indexOf(`name: "${FORMAT_NAME}"`), formats.indexOf(`name: "${FORMAT_NAME}"`) + 400);
check(block.includes(`mod: '${FORMAT_MOD}'`), `format uses mod '${FORMAT_MOD}'`);
check(block.includes(`gameType: '${FORMAT_GAME_TYPE}'`), `format is ${FORMAT_GAME_TYPE}`);
for (const rule of FORMAT_RULESET) check(block.includes(`'${rule}'`), `format ruleset includes '${rule}'`);

const bestof = read('server/room-battle-bestof.ts');
check(bestof.includes('/confirmready'), 'ready button uses /confirmready');
check(bestof.includes('`/msgroom ${room.roomid},/confirmready`'), 'ready command is sent via /msgroom to the parent room');
check(bestof.includes('|uhtml|bestof|<h2><strong>Game ${gameNum}</strong> of <a href="/${this.roomid}">'), 'sub-battle carries the |uhtml|bestof| parent link');
check(bestof.includes('|uhtml|game${gameNum}|<a href="/${battleRoom.roomid}">'), 'parent posts |uhtml|gameN| links');
check(bestof.includes('|tempnotify|choice|Next game|'), 'between-games prompt uses |tempnotify|choice|Next game|');
check(bestof.includes('is ready for game ${this.games.length + 1}.'), 'ready confirmation message text');
check(bestof.includes('this.room.add(`|win|${winner.name}`)'), 'parent room posts |win| when the set ends');
check(/BEST_OF_IN_BETWEEN_TIME = 40/.test(bestof), 'between-game timer is 40 s');

const core = read('server/chat-commands/core.ts');
check(core.includes('confirmready(target, room, user) {') && core.includes('this.requireGame(Rooms.BestOfGame)'), '/confirmready requires the BestOfGame room');
check(core.includes('useteam(target, room, user) {'), '/utm (useteam) exists');
check(core.includes('vtm(target, room, user, connection) {'), '/vtm exists');
check(!core.includes('updatechallenges'), 'server no longer sends |updatechallenges| (challenges arrive as PMs)');

const rooms = read('server/rooms.ts');
check(rooms.includes('`game-bestof${isBestOf}-${format.id}-${++Rooms.global.lastBattle}`'), 'best-of parent room id convention');

const rulesets = read('data/rulesets.ts');
check(/forceopenteamsheets: \{[\s\S]*?onTeamPreview\(\) \{\s*this\.showOpenTeamSheets\(\);/.test(rulesets), 'Force Open Team Sheets calls showOpenTeamSheets() on team preview');
const battle = read('sim/battle.ts');
check(battle.includes("this.add('showteam', side.id, Teams.pack(team));"), 'OTS is delivered as |showteam|SIDE|PACKED');
check(battle.includes("nature: this.format.mod.startsWith('champions') ? set.nature : ''"), 'OTS reveals nature only for champions');
check(battle.includes('evs: null!,') && battle.includes('ivs: null!,'), 'OTS hides EVs/IVs');

const champScripts = read('data/mods/champions/scripts.ts');
check(/canTerastallize\(pokemon\) \{\s*return null;/.test(champScripts), 'champions: no Terastallization');
check(champScripts.includes('gen: 9'), 'champions mod is gen 9');

const sd = loadShowdown();
if (sd) {
  const f = sd.Dex.formats.get(FORMAT_ID);
  check(f.exists && f.name === FORMAT_NAME, `Dex resolves ${FORMAT_ID} → ${FORMAT_NAME}`);
  const dexAny = sd.Dex as unknown as { formats: { getRuleTable(f: unknown): { pickedTeamSize: number; evLimit: number; valueRules: Map<string, string> } } };
  const rt = dexAny.formats.getRuleTable(f);
  check(rt.pickedTeamSize === PICKED_TEAM_SIZE, `picked team size is ${PICKED_TEAM_SIZE}`);
  check(rt.evLimit === STAT_POINT_TOTAL_LIMIT, `stat point limit is ${STAT_POINT_TOTAL_LIMIT}`);
  check(rt.valueRules.get('bestof') === '3', 'Best of = 3');
} else {
  console.log('warn Showdown build not loadable; skipped Dex checks (run node build in the checkout)');
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed — update ARCHITECTURE.md and the connector.`);
  process.exit(1);
}
console.log('\nAll Showdown facts verified.');
