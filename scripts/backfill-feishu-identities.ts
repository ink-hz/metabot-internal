#!/usr/bin/env node

import * as readline from 'node:readline';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadAppConfig } from '../src/config.js';
import { MessageSender } from '../src/feishu/message-sender.js';
import {
  backfillIdentityCandidates,
  type IdentityBackfillCandidate,
} from '../src/flywheel/identity-backfill.js';
import { createFlywheelRecorder } from '../src/flywheel/index.js';
import { createLogger } from '../src/utils/logger.js';


function isCandidate(value: unknown): value is IdentityBackfillCandidate {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.botId === 'string'
    && typeof candidate.chatId === 'string'
    && (candidate.conversationType === 'direct' || candidate.conversationType === 'group')
    && typeof candidate.turnId === 'string'
    && (typeof candidate.openId === 'string' || typeof candidate.unionId === 'string');
}


async function main(): Promise<void> {
  const logger = createLogger(process.env.LOG_LEVEL || 'warn');
  const botId = process.env.BACKFILL_BOT_ID?.trim();
  if (!botId) throw new Error('BACKFILL_BOT_ID is required');
  const config = loadAppConfig();
  const bot = config.feishuBots.find((candidate) => candidate.name === botId);
  if (!bot) throw new Error('Configured Feishu bot was not found');

  const candidates: IdentityBackfillCandidate[] = [];
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const parsed: unknown = JSON.parse(line);
    if (!isCandidate(parsed) || parsed.botId !== botId) throw new Error('Invalid backfill candidate');
    candidates.push(parsed);
  }

  const client = new lark.Client({
    appId: bot.feishu.appId,
    appSecret: bot.feishu.appSecret,
    disableTokenCache: false,
  });
  const sender = new MessageSender(client, logger);
  const recorder = createFlywheelRecorder({ logger, knownSecrets: [bot.feishu.appSecret] });
  try {
    const result = await backfillIdentityCandidates(candidates, {
      resolveDisplayName: (candidate) => sender.getChatMemberDisplayName(
        candidate.chatId,
        candidate.openId ?? '',
      ),
      recordIdentityObserved: (record) => recorder.recordIdentityObserved(record),
      warn: (context, message) => logger.warn(context, message),
    });
    await recorder.flush();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await recorder.close();
  }
}


main().catch(() => {
  process.stderr.write('Feishu identity backfill failed\n');
  process.exitCode = 1;
});
