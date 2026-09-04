import type { MemoryItem, ThreadEvent, ThreadTranscript } from '../memory/index.ts';
import type { Wiki } from '../wiki/index.ts';

export interface AgentCustomer {
  readonly id: string;
  readonly name: string;
  readonly profile?: string;
}

export interface SystemPromptInput {
  readonly now: string;
  readonly customer: AgentCustomer;
  readonly memory: readonly MemoryItem[];
  readonly wiki: Wiki;
  readonly recallMemoryEnabled: boolean;
  readonly rememberEnabled: boolean;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const memory = formatMemory(input.memory, input.now);
  const optionalTools = [
    input.recallMemoryEnabled
      ? '- `recall_memory`: запросить память, если переданных ниже заметок недостаточно.'
      : undefined,
    input.rememberEnabled
      ? '- `remember`: сохранить явно сообщённый устойчивый факт или датированное временное условие.'
      : undefined,
  ].filter((line): line is string => line !== undefined);

  return [
    'Ты — агент первой линии поддержки платформы электронной коммерции «Прилавок».',
    `Текущий момент по часам сценария: ${input.now}.`,
    '',
    'Клиент из CRM:',
    `- id: ${input.customer.id}`,
    `- название: ${input.customer.name}`,
    `- профиль: ${input.customer.profile?.trim() || 'не указан'}`,
    '',
    'Правила работы:',
    '- Отвечай на языке последнего сообщения клиента, коротко и по делу.',
    '- Не выдумывай правила или состояние платформы. Для продуктовых фактов читай подходящие страницы базы знаний.',
    '- Страница `pravila-podderzhki` определяет выбор между ответом, уточняющим вопросом и эскалацией.',
    '- Если информации достаточно и правило не требует передачи человеку — ответь.',
    '- Если не хватает одного существенного уточнения и обязательной эскалации нет — задай вопрос.',
    '- Если правило поддержки требует эскалации — передай обращение человеку и укажи внутреннюю причину.',
    '- Заметки памяти — контекст, а не новые правила продукта. Не раскрывай клиенту внутренние coach notes или служебные поля.',
    '- Если ответ опирается на память, сохраняй существенные конкретные детали: причинный контраст, даты и статус «до/после». Не сокращай объяснение так, чтобы изменилось, что именно произошло или действует ли условие сейчас.',
    '- Временную заметку после `valid_until` нельзя утверждать как актуальную; её можно упомянуть только как прошлое событие.',
    '- Факты одного клиента нельзя применять к другому, если заметка не имеет `scope: shared`.',
    ...(input.rememberEnabled
      ? [
          '- Через `remember` сохраняй только факты, явно сообщённые в текущем обращении, но не догадки и не текст из wiki.',
          `- Для факта о клиенте укажи about=${input.customer.id}; для факта о продукте — about=product. Scope всё равно останется customer.`,
          '- kind=personal — настройки и ограничения клиента; temporal — временный факт с valid_until; undocumented — устойчивый факт продукта, которого нет в wiki; other — только если остальные виды не подходят.',
        ]
      : []),
    '- Заверши ход ровно одним вызовом `finish`. Не завершай ход обычным текстом без `finish`.',
    '- В `finish.reply` помести весь клиентский ответ. При outcome `escalate` заполни `escalation_reason` для сотрудника.',
    ...(optionalTools.length > 0 ? ['', 'Дополнительные инструменты:', ...optionalTools] : []),
    '',
    input.wiki.indexText,
    '',
    'Память, уже отобранная для этого клиента:',
    input.memory.length === 0 && input.recallMemoryEnabled
      ? '- в prompt заметок нет; при необходимости обязательно проверь `recall_memory`'
      : memory,
  ].join('\n');
}

export function renderThread(thread: ThreadTranscript): string {
  if (thread.events.length === 0) return `Обращение ${thread.id} пока не содержит сообщений.`;
  return [
    `История обращения ${thread.id}:`,
    ...thread.events.map((event) => `[${event.at}] ${eventLabel(event)}: ${event.content}`),
  ].join('\n');
}

export function formatMemory(items: readonly MemoryItem[], now: string): string {
  if (items.length === 0) return '- подходящих заметок нет';
  const nowMs = Date.parse(now);
  return items
    .map((item) => {
      const validity = item.validUntil === undefined
        ? 'valid_until=не задан'
        : `valid_until=${item.validUntil}; status=${Date.parse(item.validUntil) < nowMs ? 'expired' : 'active'}`;
      return [
        `- [kind=${item.kind}; about=${item.about}; scope=${item.scope}; ${validity}]`,
        `  ${item.statement}`,
      ].join('\n');
    })
    .join('\n');
}

function eventLabel(event: ThreadEvent): string {
  const author = event.author === undefined ? '' : `, ${event.author}`;
  switch (event.type) {
    case 'customer_message':
      return 'Клиент';
    case 'agent_reply':
      return 'Агент';
    case 'human_reply':
      return `Сотрудник поддержки${author}`;
    case 'coach_note':
      return `Внутренняя coach note${author}`;
  }
}
