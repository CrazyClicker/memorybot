/**
 * A recording of the GitHub side for `pnpm live` without a bot identity (ROADMAP T4.6). The
 * commands replay it onto `FakeGithubClient` instead of calling GitHub, so the loop, the agent
 * and the engine can be exercised with no repository at hand. Only GitHub is faked: the model
 * calls are real unless `LLM_CACHE` replays them.
 *
 * Format (YAML): `events` play in order. An `issue` gets the next number (1, 2, …), a `comment`
 * the next comment id; `comment.issue` and `close.issue` name an issue by that number, so a
 * fixture reads like the repository it stands for and `memory_issue: 1` in live/config.yaml is
 * the first issue in the file. Append new events at the end: the numbers of everything before
 * them are already in the fake state files. The wiki on the fake's `main` is the local `wiki/`
 * directory, README included, as `readWiki` would return it.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { DEFAULT_WIKI_DIR } from '../wiki/index.ts';
import { FAKE_BOT_LOGIN, FakeGithubClient } from './fake-github.ts';
import { type GithubRepo, WIKI_DIR } from './github.ts';

export const DEFAULT_FIXTURE_PATH = 'live/fixture.yaml';

const LoginSchema = z.string().trim().min(1);
const IssueRefSchema = z.number().int().positive();

export const FixtureIssueSchema = z.strictObject({
  title: z.string().trim().min(1),
  author: LoginSchema,
  /** The form renders `### Магазин` / `### Сообщение` headings; see `events.ts`. */
  body: z.string().default(''),
  labels: z.array(z.string().trim().min(1)).default([]),
});

export const FixtureCommentSchema = z.strictObject({
  issue: IssueRefSchema,
  author: LoginSchema,
  body: z.string().min(1),
});

export const FixtureCloseSchema = z.strictObject({ issue: IssueRefSchema });

export const FixtureEventSchema = z.union([
  z.strictObject({ issue: FixtureIssueSchema }),
  z.strictObject({ comment: FixtureCommentSchema }),
  z.strictObject({ close: FixtureCloseSchema }),
]);
export type FixtureEvent = z.infer<typeof FixtureEventSchema>;

export const FixtureSchema = z
  .strictObject({
    /** The login the fake acts as; the loop skips its comments. */
    bot: LoginSchema.default(FAKE_BOT_LOGIN),
    events: z.array(FixtureEventSchema).default([]),
  })
  .superRefine((fixture, context) => {
    let opened = 0;
    fixture.events.forEach((event, index) => {
      if ('issue' in event) {
        opened += 1;
        return;
      }
      const [kind, target] = 'comment' in event ? ['comment', event.comment.issue] : ['close', event.close.issue];
      if (target > opened) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, kind, 'issue'],
          message: `refers to issue ${target}, but only ${opened} issue(s) were opened before it`,
        });
      }
    });
  });
export type Fixture = z.infer<typeof FixtureSchema>;

export function parseFixture(raw: unknown, source = '<fixture>'): Fixture {
  const parsed = FixtureSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid fixture ${source}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export async function loadFixture(path: string = DEFAULT_FIXTURE_PATH): Promise<Fixture> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read fixture ${path}: ${(error as Error).message}`, { cause: error });
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new Error(`Invalid YAML in fixture ${path}: ${(error as Error).message}`, { cause: error });
  }
  return parseFixture(raw ?? {}, path);
}

/** `wiki/*.md` from disk as files on the fake's default branch, keyed by repository path. */
export async function readWikiFiles(directory: string = DEFAULT_WIKI_DIR): Promise<Record<string, string>> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const files: Record<string, string> = {};
  for (const entry of entries) {
    files[`${WIKI_DIR}/${entry.name}`] = await readFile(join(directory, entry.name), 'utf8');
  }
  return files;
}

export interface FakeFromFixtureOptions {
  readonly repo?: GithubRepo | string;
  /** Files on `main` at start, by repository path (`readWikiFiles`). */
  readonly files?: Readonly<Record<string, string>>;
  /** Source of timestamps; the fake keeps them strictly increasing on top of it. */
  readonly now?: () => string;
}

/** Play the recording onto a fresh fake. Issue numbers and comment ids follow the file order. */
export function fakeFromFixture(fixture: Fixture, options: FakeFromFixtureOptions = {}): FakeGithubClient {
  const github = new FakeGithubClient({
    botLogin: fixture.bot,
    ...(options.repo === undefined ? {} : { repo: options.repo }),
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  for (const event of fixture.events) {
    if ('issue' in event) {
      github.openIssue(event.issue);
    } else if ('comment' in event) {
      github.commentAs(event.comment.issue, event.comment.author, event.comment.body);
    } else {
      github.closeIssue(event.close.issue);
    }
  }
  return github;
}
