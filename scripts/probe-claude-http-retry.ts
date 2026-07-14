import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

type ProbeMode = 'transient_502' | 'validation_400';

function successStream(): string {
  const events = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_probe', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ] as const;
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

async function startEndpoint(mode: ProbeMode): Promise<{
  url: string;
  postCount(): number;
  close(): Promise<void>;
}> {
  let posts = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.method === 'HEAD') {
      response.writeHead(200).end();
      return;
    }
    if (!request.url?.startsWith('/v1/messages')) {
      response.writeHead(404).end();
      return;
    }
    posts += 1;
    if (mode === 'validation_400') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'probe validation failure' },
      }));
      return;
    }
    if (posts <= 2) {
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: 'probe transient failure' },
      }));
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    response.end(successStream());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    postCount: () => posts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function runClaude(url: string): Promise<number> {
  const executable = process.env.CLAUDE_EXECUTABLE_PATH ?? 'claude';
  const settings = JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_AUTH_TOKEN: 'probe-token',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  } });
  const child = spawn(executable, [
    '-p', 'Reply with OK only.',
    '--model', 'claude-opus-4-8',
    '--tools', '',
    '--output-format', 'json',
    '--max-turns', '1',
    '--no-session-persistence',
    '--settings', settings,
  ], {
    cwd: '/tmp',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_AUTH_TOKEN: 'probe-token',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    stdio: 'ignore',
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 45_000);
  const exitCode = await new Promise<number>((resolve) => {
    child.once('error', () => resolve(127));
    child.once('exit', (code) => resolve(code ?? 1));
  });
  clearTimeout(timeout);
  return exitCode;
}

const transient = await startEndpoint('transient_502');
const validation = await startEndpoint('validation_400');
const transientExit = await runClaude(transient.url);
const validationExit = await runClaude(validation.url);
await Promise.all([transient.close(), validation.close()]);

console.log(`transient_502_posts=${transient.postCount()}`);
console.log(`transient_502_exit=${transientExit}`);
console.log(`validation_400_posts=${validation.postCount()}`);
console.log(`validation_400_exit=${validationExit}`);

process.exitCode = transient.postCount() > 1 && validation.postCount() === 1 ? 0 : 1;
