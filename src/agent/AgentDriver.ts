import { BattleAgent, TeamPreviewInput, TurnDecisionInput } from './BattleAgent';
import { LegalActions } from '../battle/LegalActionGenerator';
import { safeFallback, validateDecision } from '../battle/ActionValidator';
import { TeamPreviewDecision, TurnDecision } from '../battle/decisions';
import { DecisionRecord } from '../set/SetState';
import { Logger, silentLogger } from '../util/logger';
import { withTimeout } from '../util/async';

export interface DriverOptions {
  logger?: Logger;
  /** Per-call agent timeout. VGC move time is 55 s / turn; keep well under. */
  agentTimeoutMs?: number;
  maxAttempts?: number;
}

export interface DriverResult<T> {
  decision: T;
  usedFallback: boolean;
  attempts: DecisionRecord['attempts'];
}

/**
 * Implements the decision policy: ask the agent, validate, give it one retry
 * with the errors and legal actions, then fall back to a safe legal choice.
 */
export class AgentDriver {
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly agent: BattleAgent, options: DriverOptions = {}) {
    this.log = options.logger ?? silentLogger;
    this.timeoutMs = options.agentTimeoutMs ?? 45_000;
    this.maxAttempts = options.maxAttempts ?? 2;
  }

  async decideTeamPreview(input: TeamPreviewInput): Promise<DriverResult<TeamPreviewDecision>> {
    return this.run<TeamPreviewInput, TeamPreviewDecision>(input, input.legalTeamPreviewChoices, (i) => this.agent.chooseTeamPreview(i));
  }

  async decideTurn(input: TurnDecisionInput): Promise<DriverResult<TurnDecision>> {
    return this.run<TurnDecisionInput, TurnDecision>(input, input.legalActions, (i) => this.agent.chooseTurn(i));
  }

  private async run<I extends { retry?: TeamPreviewInput['retry'] }, D>(input: I, legal: LegalActions, call: (i: I) => Promise<D>): Promise<DriverResult<D>> {
    const attempts: DecisionRecord['attempts'] = [];
    let previous: unknown = undefined;
    let errors: string[] = [];
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const started = Date.now();
      const attemptInput: I = attempt === 1 ? input : { ...input, retry: { attempt, previousDecision: previous, errors } };
      let decision: D | undefined;
      let agentError: string | undefined;
      try {
        decision = await withTimeout(call(attemptInput), this.timeoutMs, `${this.agent.name} decision`);
      } catch (err) {
        agentError = (err as Error).message;
        this.log.warn(`agent error on attempt ${attempt}: ${agentError}`);
      }
      const latencyMs = Date.now() - started;
      if (decision !== undefined) {
        const outcome = validateDecision(decision, legal);
        attempts.push({ attempt, decision, valid: outcome.ok, errors: outcome.errors, latencyMs });
        if (outcome.ok) return { decision, usedFallback: false, attempts };
        this.log.warn(`invalid decision on attempt ${attempt}: ${outcome.errors.join(' | ')}`);
        previous = decision;
        errors = outcome.errors;
      } else {
        attempts.push({ attempt, decision: null, valid: false, errors: [agentError ?? 'no decision'], latencyMs, agentError });
        previous = null;
        errors = [agentError ?? 'agent returned nothing'];
      }
    }
    const fallback = safeFallback(legal) as D | null;
    if (!fallback) throw new Error('No legal fallback available');
    this.log.warn(`using safe fallback after ${attempts.length} failed attempt(s)`);
    return { decision: fallback, usedFallback: true, attempts };
  }
}
