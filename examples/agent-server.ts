/**
 * Reference external agent over HTTP (Milestone 13). Wraps MockBattleAgent so
 * the contract can be exercised end-to-end; replace the agent with your own.
 *
 *   npm run agent-server            # listens on :8787
 *   AGENT=http AGENT_URL=http://127.0.0.1:8787 npm run play
 */
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { MockBattleAgent } from '../src/agent/MockBattleAgent';
import { BattleAgent } from '../src/agent/BattleAgent';

export function startAgentServer(agent: BattleAgent, port = Number(process.env.AGENT_PORT ?? 8787)) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload ?? {}));
    };
    try {
      switch (req.url) {
        case '/team-preview':
          return reply(200, await agent.chooseTeamPreview(body));
        case '/turn':
          return reply(200, await agent.chooseTurn(body));
        case '/game-end':
          await agent.onGameEnd?.(body.record, body.score, body.memory);
          return reply(200, { ok: true });
        case '/set-end':
          await agent.onSetEnd?.(body.score, body.result);
          return reply(200, { ok: true });
        case '/health':
          return reply(200, { ok: true, agent: agent.name });
        default:
          return reply(404, { error: 'not found' });
      }
    } catch (err) {
      return reply(500, { error: (err as Error).message });
    }
  });
  return new Promise<{ server: typeof server; port: number }>((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({ server, port: actualPort });
    });
  });
}

if (require.main === module) {
  void startAgentServer(new MockBattleAgent()).then(({ port }) => {
    console.log(`agent server listening on http://127.0.0.1:${port}`);
  });
}
