import { ptyQuery } from '../src/engines/claude/pty/pty-query.js';
import {
  applyClaudeCompatibilityRuntime,
  startClaudeCompatibilityRuntime,
} from '../src/engines/claude/compatibility/runtime.js';
import { loadClaudeCompatibilityProfile } from '../src/engines/claude/compatibility/profile.js';
import { AsyncQueue } from '../src/utils/async-queue.js';
import { createLogger } from '../src/utils/logger.js';
import type { PtyUserMessage } from '../src/engines/claude/pty/contract.js';

const marker = 'METABOT_PTY_OK_713';
const claude = process.env.CLAUDE_BIN
  ?? new URL('../.tools/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe', import.meta.url).pathname;
const logger = createLogger('debug');
const profile = loadClaudeCompatibilityProfile();
if (!profile) throw new Error('PTY smoke test requires METABOT_CLAUDE_COMPAT_PROFILE');
const compatibilityRuntime = await startClaudeCompatibilityRuntime({
  profile,
  logger,
  claudeExecutable: claude,
});
const prompts = new AsyncQueue<PtyUserMessage>();
const queryOptions = {
  cwd: process.cwd(),
  model: 'claude-opus-4-8',
  env: {
    CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
  },
  settingsEnv: compatibilityRuntime.settingsEnv,
  pathToClaudeExecutable: claude,
  logger,
};
applyClaudeCompatibilityRuntime(queryOptions, compatibilityRuntime);
const stream = ptyQuery({
  prompt: prompts,
  options: queryOptions,
});

prompts.enqueue({
  type: 'user',
  message: { role: 'user', content: `只输出这个标记，不要添加其他内容：${marker}` },
  parent_tool_use_id: null,
  session_id: '',
});

const timer = setTimeout(async () => {
  await stream.dispose?.();
  await compatibilityRuntime.close();
  console.error('PTY smoke test timed out');
  process.exit(2);
}, 60_000);

let assistantText = '';
let successful = false;
for await (const message of stream) {
  if (message.type === 'assistant') {
    for (const block of message.message?.content ?? []) {
      if (block.type === 'text' && block.text) assistantText += block.text;
    }
  }
  if (message.type === 'result') {
    successful = message.subtype === 'success' && message.is_error !== true;
    clearTimeout(timer);
    await stream.dispose?.();
    await compatibilityRuntime.close();
    break;
  }
}

if (!successful || assistantText.trim() !== marker) {
  console.error(JSON.stringify({ successful, assistantText: assistantText.trim() }));
  process.exit(1);
}
console.log(marker);
