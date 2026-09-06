import { describe, expect, it } from 'vitest';

import { parseLiveConfig } from './config.ts';
import { issueMessage, parseCommand, parseIssueForm, resolveIssueCustomer } from './events.ts';

const CONFIG = parseLiveConfig({
  repo: 'CrazyClicker/memorybot',
  humans: ['CrazyClicker'],
  customers: {
    dom_i_sad: { form: 'Дом и сад', name: 'Дом и сад' },
    velo_dvor: { form: 'ВелоДвор', name: 'ВелоДвор', logins: ['velo-dvor'] },
  },
});

const FORM_BODY = [
  '### Магазин',
  '',
  'Дом и сад',
  '',
  '### Сообщение',
  '',
  'Здравствуйте! После импорта пропали 37 строк.',
  '',
  'Файл чистый.',
  '',
].join('\n');

describe('parseIssueForm', () => {
  it('reads the heading sections the form renders, empty optional fields included', () => {
    const form = parseIssueForm(`Intro text\r\n${FORM_BODY.replaceAll('\n', '\r\n')}\r\n### Файл\r\n\r\n_No response_`);
    expect([...form.keys()]).toEqual(['Магазин', 'Сообщение', 'Файл']);
    expect(form.get('Магазин')).toBe('Дом и сад');
    expect(form.get('Сообщение')).toBe('Здравствуйте! После импорта пропали 37 строк.\n\nФайл чистый.');
    expect(form.get('Файл')).toBe('');
    expect(parseIssueForm('plain text without headings').size).toBe(0);
  });
});

describe('resolveIssueCustomer and issueMessage', () => {
  it('prefers the form field, then the login map', () => {
    expect(resolveIssueCustomer({ body: FORM_BODY, author: 'stranger' }, CONFIG)).toEqual({ id: 'dom_i_sad', via: 'form' });
    expect(resolveIssueCustomer({ body: FORM_BODY, author: 'velo-dvor' }, CONFIG)).toEqual({ id: 'dom_i_sad', via: 'form' });
    expect(resolveIssueCustomer({ body: 'no form', author: 'Velo-Dvor' }, CONFIG)).toEqual({ id: 'velo_dvor', via: 'login' });
    const unknownForm = FORM_BODY.replace('Дом и сад', 'Лаванда');
    expect(resolveIssueCustomer({ body: unknownForm, author: 'velo-dvor' }, CONFIG)).toEqual({ id: 'velo_dvor', via: 'login' });
    expect(resolveIssueCustomer({ body: unknownForm, author: 'stranger' }, CONFIG)).toBeUndefined();
    expect(resolveIssueCustomer({ body: '', author: 'CrazyClicker' }, CONFIG)).toBeUndefined();
  });

  it('builds the customer message from the subject and the message field, or the whole body', () => {
    expect(issueMessage({ title: ' Пропали строки ', body: FORM_BODY })).toBe(
      'Пропали строки\n\nЗдравствуйте! После импорта пропали 37 строк.\n\nФайл чистый.',
    );
    expect(issueMessage({ title: 'Вопрос', body: 'Просто текст.\n' })).toBe('Вопрос\n\nПросто текст.');
    expect(issueMessage({ title: '', body: 'Просто текст.' })).toBe('Просто текст.');
    const merchantOnly = '### Магазин\n\nДом и сад\n';
    expect(issueMessage({ title: 'Только тема', body: merchantOnly })).toBe('Только тема');
  });
});

describe('parseCommand', () => {
  it('recognises the three commands and their scopes', () => {
    expect(parseCommand('/coach Причина — BOM в заголовке.\nОбход: пересохранить.')).toEqual({
      kind: 'coach',
      scope: 'customer',
      text: 'Причина — BOM в заголовке.\nОбход: пересохранить.',
    });
    expect(parseCommand('  /coach product Инцидент с картами до 18:00. ')).toEqual({
      kind: 'coach',
      scope: 'product',
      text: 'Инцидент с картами до 18:00.',
    });
    expect(parseCommand('/coach productivity note')).toEqual({ kind: 'coach', scope: 'customer', text: 'productivity note' });
    expect(parseCommand('/clock 2026-09-10T18:30:00Z')).toEqual({ kind: 'clock', target: '2026-09-10T18:30:00Z' });
    expect(parseCommand('/clock 2026-09-10 trailing words')).toEqual({ kind: 'clock', target: '2026-09-10' });
    expect(parseCommand('/consolidate')).toEqual({ kind: 'consolidate' });
  });

  it('flags a known command with a bad argument and leaves everything else as a reply', () => {
    expect(parseCommand('/coach')).toEqual({ kind: 'invalid', command: 'coach', reason: 'the note text is missing' });
    expect(parseCommand('/coach product')).toEqual({ kind: 'invalid', command: 'coach', reason: 'the note text is missing' });
    expect(parseCommand('/clock tomorrow')).toMatchObject({ kind: 'invalid', command: 'clock' });
    expect(parseCommand('/clock')).toMatchObject({ kind: 'invalid', command: 'clock' });
    expect(parseCommand('/consolidate now')).toMatchObject({ kind: 'invalid', command: 'consolidate' });
    expect(parseCommand('Посмотрю файл, отвечу через час.')).toBeUndefined();
    expect(parseCommand('/unknown thing')).toBeUndefined();
    expect(parseCommand('/coaching tips')).toBeUndefined();
    expect(parseCommand('see /coach above')).toBeUndefined();
  });
});
