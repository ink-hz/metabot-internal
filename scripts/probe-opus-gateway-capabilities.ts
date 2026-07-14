import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export interface ProbeObservation {
  exitCode: number;
  latencyMs: number;
  completedRequests: number;
  output: string;
  httpStatus?: number;
  networkError?: boolean;
}

export type NativeWebStatus =
  | 'available'
  | 'upstream_unsupported'
  | 'domain_verification_failed'
  | 'transport_error'
  | 'unexpected_error';

export interface NativeWebEvidence {
  status: NativeWebStatus;
  httpStatus?: number;
  providerErrorType?: string;
  completedRequests: number;
  latencyMs: number;
}

export interface CapabilityEvidence {
  profileId: string;
  model: string;
  claudeCodeVersion: string;
  observedAt: string;
  nativeWebSearch: NativeWebEvidence;
  nativeWebFetch: NativeWebEvidence;
}

export function classifyNativeWebSearch(observation: ProbeObservation): NativeWebEvidence {
  const base = {
    completedRequests: observation.completedRequests,
    latencyMs: observation.latencyMs,
    ...(observation.httpStatus !== undefined ? { httpStatus: observation.httpStatus } : {}),
  };
  if (observation.exitCode === 0 && observation.completedRequests > 0) {
    return { ...base, status: 'available' };
  }
  if (observation.networkError) return { ...base, status: 'transport_error' };
  if (/web_search_20250305[\s\S]{0,160}not supported|ValidationException[\s\S]{0,200}web_search_20250305/i.test(observation.output)) {
    return { ...base, status: 'upstream_unsupported', providerErrorType: 'aws_invoke_error' };
  }
  return { ...base, status: 'unexpected_error' };
}

export function classifyNativeWebFetch(observation: ProbeObservation): NativeWebEvidence {
  const base = {
    completedRequests: observation.completedRequests,
    latencyMs: observation.latencyMs,
    ...(observation.httpStatus !== undefined ? { httpStatus: observation.httpStatus } : {}),
  };
  if (observation.exitCode === 0 && observation.completedRequests > 0) {
    return { ...base, status: 'available' };
  }
  if (observation.networkError) return { ...base, status: 'transport_error' };
  if (/unable to verify whether domain|domain[- ]safety|safe to access/i.test(observation.output)) {
    return { ...base, status: 'domain_verification_failed' };
  }
  return { ...base, status: 'unexpected_error' };
}

export function buildCapabilityEvidence(input: {
  profileId: string;
  model: string;
  claudeCodeVersion: string;
  search: ProbeObservation;
  fetch: ProbeObservation;
}): CapabilityEvidence {
  return {
    profileId: input.profileId,
    model: input.model,
    claudeCodeVersion: input.claudeCodeVersion,
    observedAt: new Date().toISOString(),
    nativeWebSearch: classifyNativeWebSearch(input.search),
    nativeWebFetch: classifyNativeWebFetch(input.fetch),
  };
}

export function writeCapabilityEvidence(
  evidence: CapabilityEvidence,
  home = homedir(),
): string {
  const target = join(home, '.metabot', 'capabilities', `${evidence.profileId}.json`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  return target;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

async function runNativeToolProbe(args: {
  executable: string;
  model: string;
  tool: 'WebSearch' | 'WebFetch';
  prompt: string;
}): Promise<ProbeObservation> {
  const startedAt = Date.now();
  const child = spawn(args.executable, [
    '-p', args.prompt,
    '--model', args.model,
    '--tools', args.tool,
    '--allowedTools', args.tool,
    '--output-format', 'json',
    '--max-turns', '3',
    '--max-budget-usd', '1',
    '--no-session-persistence',
  ], {
    cwd: '/tmp',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000);
  const exitCode = await new Promise<number>((done) => {
    child.once('error', () => done(127));
    child.once('exit', (code) => done(code ?? 1));
  });
  clearTimeout(timeout);
  const output = Buffer.concat([...stdout, ...stderr]).toString('utf8');
  let parsed: {
    api_error_status?: unknown;
    usage?: {
      server_tool_use?: {
        web_search_requests?: unknown;
        web_fetch_requests?: unknown;
      };
    };
  } | undefined;
  try {
    parsed = JSON.parse(Buffer.concat(stdout).toString('utf8')) as typeof parsed;
  } catch {
    parsed = undefined;
  }
  const serverUse = parsed?.usage?.server_tool_use;
  const completedRequests = args.tool === 'WebSearch'
    ? safeNumber(serverUse?.web_search_requests) ?? 0
    : safeNumber(serverUse?.web_fetch_requests) ?? 0;
  const explicitStatus = safeNumber(parsed?.api_error_status);
  const matchedStatus = /API Error:\s*(\d{3})/i.exec(output)?.[1];
  const httpStatus = explicitStatus ?? (matchedStatus ? Number(matchedStatus) : undefined);
  return {
    exitCode,
    latencyMs: Date.now() - startedAt,
    completedRequests,
    output,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    networkError: /ECONNREFUSED|ENOTFOUND|fetch failed|connect(?:ion)? (?:failed|refused)/i.test(output),
  };
}

async function main(): Promise<void> {
  const executable = process.env.CLAUDE_EXECUTABLE_PATH ?? 'claude';
  const model = 'claude-opus-4-8';
  const versionOutput = spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout ?? '';
  const claudeCodeVersion = /\b(\d+\.\d+\.\d+)\b/.exec(versionOutput)?.[1] ?? 'unknown';
  const search = await runNativeToolProbe({
    executable,
    model,
    tool: 'WebSearch',
    prompt: '必须调用 WebSearch 搜索“奥比中光 2026 最新新闻”，只返回标题和来源网址；不得依靠已有知识。',
  });
  const fetch = await runNativeToolProbe({
    executable,
    model,
    tool: 'WebFetch',
    prompt: '必须调用 WebFetch 读取 https://example.com/ ，只返回网页标题。',
  });
  const evidence = buildCapabilityEvidence({
    profileId: 'nexcor-opus-4-8-claude-code-2.1.207',
    model,
    claudeCodeVersion,
    search,
    fetch,
  });
  const evidencePath = writeCapabilityEvidence(evidence);
  console.log(JSON.stringify({
    evidencePath,
    nativeWebSearch: evidence.nativeWebSearch,
    nativeWebFetch: evidence.nativeWebFetch,
  }, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`Capability probe infrastructure failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
