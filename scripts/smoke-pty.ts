import { ptyQuery } from '../src/engines/claude/pty/pty-query.js';
import { AsyncQueue } from '../src/utils/async-queue.js';
import { createLogger } from '../src/utils/logger.js';
import type { PtyUserMessage } from '../src/engines/claude/pty/contract.js';

const marker = 'METABOT_PTY_OK_713';
const claude = process.env.CLAUDE_BIN
  ?? new URL('../.tools/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe', import.meta.url).pathname;
const prompts = new AsyncQueue<PtyUserMessage>();
const stream = ptyQuery({
  prompt: prompts,
  options: {
    cwd: process.cwd(),
    model: 'fable',
    pathToClaudeExecutable: claude,
    logger: createLogger('warn'),
  },
});

prompts.enqueue({
  type: 'user',
  message: { role: 'user', content: `只输出这个标记，不要添加其他内容：${marker}` },
  parent_tool_use_id: null,
  session_id: '',
});

const timer = setTimeout(async () => {
  await stream.dispose?.();
  console.error('PTY smoke test timed out');
  process.exit(2);
}, 60_000);

let transcript = '';
for await (const message of stream) {
  transcript += `${JSON.stringify(message)}\n`;
  if ((message as { type?: string }).type === 'result') {
    clearTimeout(timer);
    await stream.dispose?.();
    break;
  }
}

if (!transcript.includes(marker)) {
  console.error(transcript);
  process.exit(1);
}
console.log(marker);
