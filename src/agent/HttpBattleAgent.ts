import { BattleAgent, SetScore, TeamPreviewInput, TurnDecisionInput } from './BattleAgent';
import { TeamPreviewDecision, TurnDecision } from '../battle/decisions';
import { GameRecord } from '../set/SetState';
import { SetMemory } from '../set/SetMemory';

export interface HttpBattleAgentOptions {
  /** Base URL of the external agent, e.g. http://127.0.0.1:8787 */
  baseUrl: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/**
 * External agent over HTTP. Contract (JSON in / JSON out):
 *
 *   POST {baseUrl}/team-preview   body: TeamPreviewInput   → TeamPreviewDecision
 *   POST {baseUrl}/turn           body: TurnDecisionInput  → TurnDecision
 *   POST {baseUrl}/game-end       body: { record, score, memory }   (optional, fire-and-forget)
 *   POST {baseUrl}/set-end        body: { score, result }           (optional)
 *
 * See examples/agent-server.ts for a reference implementation.
 */
export class HttpBattleAgent implements BattleAgent {
  readonly name: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpBattleAgentOptions) {
    this.name = `HttpBattleAgent(${options.baseUrl})`;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  chooseTeamPreview(input: TeamPreviewInput): Promise<TeamPreviewDecision> {
    return this.post<TeamPreviewDecision>('/team-preview', input);
  }

  chooseTurn(input: TurnDecisionInput): Promise<TurnDecision> {
    return this.post<TurnDecision>('/turn', input);
  }

  async onGameEnd(record: GameRecord, score: SetScore, memory: SetMemory): Promise<void> {
    await this.post('/game-end', { record: { ...record, battleEvents: undefined, finalState: undefined }, score, memory }, true);
  }

  async onSetEnd(score: SetScore, result: 'win' | 'loss' | 'tie'): Promise<void> {
    await this.post('/set-end', { score, result }, true);
  }

  private async post<T>(path: string, body: unknown, optional = false): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    try {
      const res = await this.fetchImpl(this.options.baseUrl.replace(/\/$/, '') + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.options.headers ?? {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (optional && res.status === 404) return undefined as T;
        throw new Error(`Agent ${path} responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (err) {
      if (optional) return undefined as T;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
