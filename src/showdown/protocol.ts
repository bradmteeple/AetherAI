/**
 * Pokémon Showdown wire protocol parsing (PROTOCOL.md).
 *
 * Server → client frames look like:
 *
 *     >ROOMID\n|TYPE|ARG|ARG...\n|TYPE|...
 *
 * `>ROOMID` may be omitted for global messages. Lines that don't start with
 * `|` are plain log text. `||MESSAGE` is a log message.
 */
export interface RoomMessage {
  /** Room id, or '' for global/lobby-less messages. */
  room: string;
  /** Message type (`init`, `request`, `win`, `c`, ...). '' for plain text lines. */
  type: string;
  /** Arguments split on `|`. */
  args: string[];
  /** Everything after `|TYPE|` unsplit (needed for `request`, `c`, `html`, ...). */
  rest: string;
  /** The raw line. */
  raw: string;
}

export function parseLine(room: string, line: string): RoomMessage {
  if (!line.startsWith('|')) {
    return { room, type: '', args: [line], rest: line, raw: line };
  }
  // "||text" → type '' with the text as the only argument (plain log message).
  if (line.startsWith('||')) {
    const text = line.slice(2);
    return { room, type: '', args: [text], rest: text, raw: line };
  }
  const secondPipe = line.indexOf('|', 1);
  if (secondPipe < 0) {
    return { room, type: line.slice(1), args: [], rest: '', raw: line };
  }
  const type = line.slice(1, secondPipe);
  const rest = line.slice(secondPipe + 1);
  return { room, type, args: rest.split('|'), rest, raw: line };
}

export function parseFrame(data: string): RoomMessage[] {
  if (!data) return [];
  const lines = data.split('\n');
  let room = '';
  const out: RoomMessage[] = [];
  let first = true;
  for (const line of lines) {
    if (first && line.startsWith('>')) {
      room = line.slice(1).trim();
      first = false;
      continue;
    }
    first = false;
    if (!line) continue;
    out.push(parseLine(room, line));
  }
  return out;
}

/** Split `|pm|SENDER|RECEIVER|MESSAGE` keeping pipes inside MESSAGE. */
export function parsePm(msg: RoomMessage): { sender: string; receiver: string; message: string } | null {
  if (msg.type !== 'pm') return null;
  const [sender, receiver, ...messageParts] = msg.args;
  return { sender: sender ?? '', receiver: receiver ?? '', message: messageParts.join('|') };
}

/** For `|c|USER|MESSAGE` / `|c:|TS|USER|MESSAGE`. */
export function parseChat(msg: RoomMessage): { user: string; message: string; timestamp?: number } | null {
  if (msg.type === 'c' || msg.type === 'chat') {
    const [user, ...messageParts] = msg.args;
    return { user: user ?? '', message: messageParts.join('|') };
  }
  if (msg.type === 'c:') {
    const [ts, user, ...messageParts] = msg.args;
    return { user: user ?? '', message: messageParts.join('|'), timestamp: Number(ts) };
  }
  return null;
}
