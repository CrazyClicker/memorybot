#!/usr/bin/env tsx
/**
 * `pnpm live <command>` (ROADMAP §6, T4.6): the executable around `runLiveCli`. Everything
 * testable is in `commands.ts`; this file only reads `.env` and the process arguments.
 */
import 'dotenv/config';

import { runLiveCli } from './commands.ts';

process.exitCode = await runLiveCli(process.argv.slice(2));
