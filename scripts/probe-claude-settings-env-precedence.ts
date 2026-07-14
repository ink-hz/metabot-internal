import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

type ListenerName = 'process_env' | 'settings_json';

const counts: Record<ListenerName, Map<string, number>> = {
  process_env: new Map(),
  settings_json: new Map(),
};

let resolveMessagesRequest: (() => void) | undefined;
const messagesRequest = new Promise<void>((resolve) => {
  resolveMessagesRequest = resolve;
});

function listener(name: ListenerName) {
  return createServer((request, response) => {
    const key = `${request.method ?? 'UNKNOWN'} ${request.url ?? '/'}`;
    counts[name].set(key, (counts[name].get(key) ?? 0) + 1);

    if (request.url?.startsWith('/v1/messages')) {
      resolveMessagesRequest?.();
    }

    if (request.method === 'HEAD' && request.url === '/') {
      response.writeHead(200).end();
      return;
    }

    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'authentication_error',
        message: 'Invalid authentication credentials',
      },
    }));
  });
}

async function listen(name: ListenerName): Promise<{
  server: ReturnType<typeof listener>;
  url: string;
}> {
  const server = listener(name);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function count(name: ListenerName, key: string): number {
  return counts[name].get(key) ?? 0;
}

function formatCounts(name: ListenerName): string {
  return JSON.stringify(Object.fromEntries(
    [...counts[name].entries()].sort(([left], [right]) => left.localeCompare(right)),
  ));
}

const processEnv = await listen('process_env');
const settingsJson = await listen('settings_json');
const claude = process.env.CLAUDE_EXECUTABLE_PATH ?? 'claude';

const child = spawn(claude, [
  '-p', 'Reply with OK only.',
  '--model', 'claude-opus-4-8',
  '--output-format', 'json',
  '--settings', JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: settingsJson.url,
    ANTHROPIC_AUTH_TOKEN: 'probe-token',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  } }),
], {
  cwd: '/tmp',
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: processEnv.url,
    ANTHROPIC_AUTH_TOKEN: 'probe-token',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  },
  stdio: 'ignore',
});

const timeout = setTimeout(() => resolveMessagesRequest?.(), 8_000);
await messagesRequest;
clearTimeout(timeout);
child.kill();

await Promise.all([
  new Promise<void>((resolve) => processEnv.server.close(() => resolve())),
  new Promise<void>((resolve) => settingsJson.server.close(() => resolve())),
]);

const processEnvRequests = [...counts.process_env.values()]
  .reduce((sum, value) => sum + value, 0);
const settingsPost = count('settings_json', 'POST /v1/messages?beta=true');
const winner = processEnvRequests === 0 && settingsPost > 0
  ? 'settings_json'
  : count('process_env', 'POST /v1/messages?beta=true') > 0
    ? 'process_env'
    : 'none';

console.log(`winner=${winner}`);
console.log(`process_env=${formatCounts('process_env')}`);
console.log(`settings_json=${formatCounts('settings_json')}`);

process.exitCode = processEnvRequests === 0 && settingsPost > 0 ? 0 : 1;
