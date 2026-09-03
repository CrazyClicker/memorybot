/**
 * Deterministic checks: everything an `expect` block can decide without an LLM call.
 *
 * These run before the judge (ROADMAP principle 7, "cheap first"), so a scenario that fails
 * on `outcome` or a regex costs nothing. What is left — `uses`, `must_not_use`,
 * `reply.rubric` and the knowledge side of the probes — belongs to judge.ts.
 *
 * Check keys are the report's row labels and must stay stable across runs:
 * `outcome`, `reply.must[0]`, `reply.must_not[1]`, `escalation.reason_must[0]`,
 * `must_not[0]` (probes), and the judged `uses:K3`, `must_not_use:K1`, `reply.rubric`,
 * `recalls:K1`, `must_not_recall:K2`, `proposes:K4`.
 */
import {
  type CheckResult,
  compilePattern,
  type Expect,
  type MemoryItem,
  type Outcome,
  type Pattern,
  type Probe,
  type Score,
} from './schema.ts';

/** What a `agent_turn` produced, reduced to the fields an expectation can see. */
export interface TurnObservation {
  readonly outcome: Outcome;
  readonly reply: string;
  readonly escalationReason?: string;
}

/**
 * `expect.outcome`, `expect.reply.must/must_not` and `expect.escalation.reason_must`.
 * An absent `expect` produces no checks: a turn may exist only to move the story on.
 */
export function checkTurn(expect: Expect | undefined, turn: TurnObservation): CheckResult[] {
  if (expect === undefined) return [];
  const checks: CheckResult[] = [];

  if (expect.outcome !== undefined) {
    checks.push(checkOutcome(expect.outcome, expect.tolerated ?? [], turn.outcome));
  }

  checks.push(...matchAll('reply.must', expect.reply?.must, turn.reply, true, 'the reply'));
  checks.push(...matchAll('reply.must_not', expect.reply?.must_not, turn.reply, false, 'the reply'));

  const reasonMust = expect.escalation?.reason_must;
  if (reasonMust !== undefined && reasonMust.length > 0) {
    checks.push(...checkEscalationReason(reasonMust, turn));
  }

  return checks;
}

/**
 * A probe's `must_not` patterns against the text of what the engine returned. Whether the
 * expected knowledge is in there is a judge call; leaked names and numbers are not.
 * `returned: undefined` means the engine cannot serve the probe: `skipped`, never `fail`.
 */
export function checkProbePatterns(
  probe: Probe,
  returned: readonly MemoryItem[] | undefined,
): CheckResult[] {
  const patterns = probe.expect.must_not;
  if (patterns === undefined || patterns.length === 0) return [];
  if (returned === undefined) {
    return patterns.map((_pattern, index) => ({
      key: `must_not[${index}]`,
      verdict: 'skipped' as const,
      why: `${probe.type === 'documentation_proposals' ? 'proposals()' : 'recall()'} is not served by this engine`,
    }));
  }
  return matchAll('must_not', patterns, memoryText(returned), false, 'what the engine returned');
}

/** The text a judge or a pattern sees for a set of memory items: one statement per line. */
export function memoryText(items: readonly MemoryItem[]): string {
  return items.map((item) => item.statement).join('\n');
}

export function scoreOf(checks: readonly CheckResult[]): Score {
  const score: Score = { pass: 0, partial: 0, fail: 0, skipped: 0 };
  for (const check of checks) score[check.verdict] += 1;
  return score;
}

function checkOutcome(
  expected: Outcome,
  tolerated: readonly Outcome[],
  actual: Outcome,
): CheckResult {
  if (actual === expected) return { key: 'outcome', verdict: 'pass' };
  if (tolerated.includes(actual)) {
    return {
      key: 'outcome',
      verdict: 'partial',
      why: `expected "${expected}", got tolerated "${actual}"`,
    };
  }
  return { key: 'outcome', verdict: 'fail', why: `expected "${expected}", got "${actual}"` };
}

/**
 * An expected escalation reason with no escalation is a fail, not a skip: the scenario asked
 * for a reason and there is none. The `outcome` check reports the same turn separately, so
 * the report shows both what went wrong and what it cost.
 */
function checkEscalationReason(patterns: readonly Pattern[], turn: TurnObservation): CheckResult[] {
  const reason = turn.escalationReason;
  if (reason === undefined || reason.trim() === '') {
    return patterns.map((_pattern, index) => ({
      key: `escalation.reason_must[${index}]`,
      verdict: 'fail' as const,
      why: `no escalation reason: the turn ended as "${turn.outcome}"`,
    }));
  }
  return matchAll(
    'escalation.reason_must',
    patterns,
    reason,
    true,
    'the escalation reason',
  );
}

function matchAll(
  key: string,
  patterns: readonly Pattern[] | undefined,
  text: string,
  shouldMatch: boolean,
  subject: string,
): CheckResult[] {
  if (patterns === undefined) return [];
  return patterns.map((pattern, index) => {
    const matched = compilePattern(pattern).test(text);
    return matched === shouldMatch
      ? { key: `${key}[${index}]`, verdict: 'pass' as const }
      : {
          key: `${key}[${index}]`,
          verdict: 'fail' as const,
          why: `${subject} ${matched ? 'matches' : 'does not match'} ${pattern}`,
        };
  });
}
