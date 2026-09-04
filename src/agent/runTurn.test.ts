import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import type { MemoryItem, ThreadTranscript } from '../memory/index.ts';
import { Wiki } from '../wiki/index.ts';
import { AgentDidNotFinishError, FINISH_NUDGE, MAX_AGENT_STEPS, runTurn, type TurnInput } from './runTurn.ts';

const NOW = '2026-09-05T15:00:00Z';
type MockGenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

function usage(input = 10, output = 5): MockGenerateResult['usage'] {
  return {
    inputTokens: { total: input, noCache: input - 2, cacheRead: 2, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function toolCall(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
): MockGenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: usage(),
    warnings: [],
  };
}

function textResult(text: string): MockGenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: usage(),
    warnings: [],
  };
}

function memory(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'memory-1',
    kind: 'personal',
    about: 'kofe_tochka',
    learnedFrom: 'kofe_tochka',
    scope: 'customer',
    statement: 'По состоянию на 2026-09-05: магазин использует двухстадийную оплату.',
    source: { thread: 'thread-old', via: 'consolidate' },
    createdAt: '2026-09-05T10:00:00Z',
    ...overrides,
  };
}

function turnInput(overrides: Partial<TurnInput> = {}): TurnInput {
  const thread: ThreadTranscript = {
    id: 'thread-current',
    customer: 'kofe_tochka',
    events: [
      {
        type: 'customer_message',
        at: NOW,
        content: 'Почему покупатель не может оплатить заказ картой?',
      },
    ],
  };
  return {
    now: NOW,
    customer: { id: 'kofe_tochka', name: 'Кофе-точка', profile: 'Обжаривает кофе под заказ.' },
    thread,
    memory: [memory()],
    tools: { recallMemory: true, remember: true },
    wiki: new Wiki([
      {
        slug: 'pravila-podderzhki',
        title: 'Правила поддержки',
        summary: 'Когда отвечать и когда эскалировать.',
        content: 'Платёжные споры эскалируются.',
      },
    ]),
    model: { provider: 'openai', model: 'gpt-4o-mini', temperature: 0 },
    ...overrides,
  };
}

describe('runTurn', () => {
  it('runs the AI SDK 7 tool loop, records trace and returns the mandatory finish value', async () => {
    const model = new MockLanguageModelV4({
      provider: 'openai',
      modelId: 'gpt-4o-mini',
      doGenerate: [
        toolCall('read_page', { slug: 'pravila-podderzhki' }, 'call-read'),
        toolCall('recall_memory', { query: 'сбой оплаты картой' }, 'call-recall'),
        toolCall(
          'remember',
          {
            kind: 'temporal',
            about: 'kofe_tochka',
            statement: 'Карточная оплата не работает.',
            valid_until: '2026-09-05T18:00:00Z',
          },
          'call-remember',
        ),
        toolCall(
          'finish',
          {
            outcome: 'escalate',
            reply: 'Передаю вопрос специалисту по платежам.',
            escalation_reason: 'P-001: вопрос о платеже.',
          },
          'call-finish',
        ),
      ],
    });
    const recalled = memory({
      id: 'shared-incident',
      kind: 'temporal',
      about: 'product',
      scope: 'shared',
      statement: 'По состоянию на 2026-09-05: у провайдера сбой.',
      validUntil: '2026-09-05T18:00:00Z',
    });
    const clock = [100, 145];

    const result = await runTurn(turnInput({
      memory: [
        memory(),
        memory({
          id: 'expired-memory',
          kind: 'temporal',
          statement: 'По состоянию на 2026-09-05: старый сбой.',
          validUntil: '2026-09-05T14:00:00Z',
        }),
      ],
    }), {
      model,
      recallMemory: async (customer, query, now) => {
        expect({ customer, query, now }).toEqual({
          customer: 'kofe_tochka',
          query: 'сбой оплаты картой',
          now: NOW,
        });
        return [recalled];
      },
      nowMs: () => clock.shift() ?? 145,
    });

    expect(result).toMatchObject({
      outcome: 'escalate',
      reply: 'Передаю вопрос специалисту по платежам.',
      escalationReason: 'P-001: вопрос о платеже.',
      latencyMs: 45,
      usage: {
        inputTokens: 40,
        uncachedInputTokens: 32,
        cacheReadTokens: 8,
        cacheWriteTokens: 0,
        outputTokens: 20,
      },
    });
    expect(result.costUsd).toBeCloseTo(0.0000174);
    expect(result.memoryWrites).toEqual([
      expect.objectContaining({
        id: 'agent-thread-current-1',
        kind: 'temporal',
        learnedFrom: 'kofe_tochka',
        scope: 'customer',
        statement: 'По состоянию на 2026-09-05: Карточная оплата не работает.',
        validUntil: '2026-09-05T18:00:00Z',
        source: { thread: 'thread-current', via: 'agent' },
        createdAt: NOW,
      }),
    ]);
    expect(result.trace.map(({ toolCalls }) => toolCalls[0]?.tool)).toEqual([
      'read_page',
      'recall_memory',
      'remember',
      'finish',
    ]);
    expect(result.trace[0]?.toolCalls[0]?.output).toContain('Платёжные споры эскалируются.');
    expect(result.trace[1]?.toolCalls[0]?.output).toEqual([{ ...recalled, status: 'active' }]);

    const firstCall = JSON.stringify(model.doGenerateCalls[0]?.prompt);
    expect(firstCall).toContain('Текущий момент по часам сценария: 2026-09-05T15:00:00Z');
    expect(firstCall).toContain('Кофе-точка');
    expect(firstCall).toContain('kind=personal');
    expect(firstCall).toContain('двухстадийную оплату');
    expect(firstCall).toContain('valid_until=2026-09-05T14:00:00Z; status=expired');
    expect(firstCall).toContain('pravila-podderzhki');
    expect(firstCall).toContain('Почему покупатель не может оплатить заказ картой?');
  });

  it('exposes only enabled optional tools', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: toolCall('finish', { outcome: 'answer', reply: 'Готово.' }, 'call-finish'),
    });
    await runTurn(
      turnInput({ tools: { recallMemory: false, remember: false }, memory: [] }),
      { model },
    );

    const names = model.doGenerateCalls[0]?.tools?.map((candidate) => candidate.name).sort();
    expect(names).toEqual(['finish', 'read_page']);
  });

  it('sends temperature only when the model config sets it', async () => {
    const withoutTemperature = new MockLanguageModelV4({
      doGenerate: toolCall('finish', { outcome: 'answer', reply: 'Готово.' }, 'call-finish'),
    });
    await runTurn(
      turnInput({ model: { provider: 'openai', model: 'gpt-5.6-terra' } }),
      { model: withoutTemperature },
    );
    expect(withoutTemperature.doGenerateCalls[0]?.temperature).toBeUndefined();

    const withTemperature = new MockLanguageModelV4({
      doGenerate: toolCall('finish', { outcome: 'answer', reply: 'Готово.' }, 'call-finish'),
    });
    await runTurn(
      turnInput({ model: { provider: 'openai', model: 'gpt-4o-mini', temperature: 0 } }),
      { model: withTemperature },
    );
    expect(withTemperature.doGenerateCalls[0]?.temperature).toBe(0);
  });

  it('nudges once when the model stops in plain text, and keeps both parts in the trace', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        textResult('Обычный ответ без вызова finish.'),
        toolCall('finish', { outcome: 'answer', reply: 'Обычный ответ без вызова finish.' }, 'call-finish'),
      ],
    });
    const result = await runTurn(turnInput(), { model });
    expect(result.outcome).toBe('answer');
    expect(result.trace.map((step) => step.step)).toEqual([1, 2]);
    expect(result.trace[0]?.text).toBe('Обычный ответ без вызова finish.');
    expect(result.trace[1]?.toolCalls[0]?.tool).toBe('finish');
    expect(result.usage.inputTokens).toBe(20);
    const nudge = JSON.stringify(model.doGenerateCalls[1]?.prompt);
    expect(nudge).toContain('Обычный ответ без вызова finish.');
    expect(nudge).toContain(FINISH_NUDGE);
  });

  it('rejects a natural-language response that does not call finish', async () => {
    const model = new MockLanguageModelV4({ doGenerate: textResult('Обычный ответ.') });
    await expect(runTurn(turnInput(), { model })).rejects.toMatchObject({ steps: 2, finishReason: 'stop' });
    expect(model.doGenerateCalls).toHaveLength(2);
  });

  it('stops after eight model steps when finish is never called', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: Array.from({ length: MAX_AGENT_STEPS }, (_, index) =>
        toolCall('read_page', { slug: 'pravila-podderzhki' }, `call-read-${index}`),
      ),
    });
    await expect(runTurn(turnInput(), { model })).rejects.toMatchObject({ steps: MAX_AGENT_STEPS });
    expect(model.doGenerateCalls).toHaveLength(MAX_AGENT_STEPS);
  });
});
