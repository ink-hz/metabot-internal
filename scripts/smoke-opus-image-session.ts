import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PersistentClaudeExecutor } from '../src/engines/claude/persistent-executor.js';
import type { SDKMessage } from '../src/engines/claude/executor.js';
import { claudeProjectDirectoryName } from '../src/engines/claude/pty/pty-session.js';
import { OPUS_PROFILE } from '../src/engines/claude/compatibility/profile.js';
import {
  clearActiveClaudeCompatibilityRuntime,
  setActiveClaudeCompatibilityRuntime,
  startClaudeCompatibilityRuntime,
} from '../src/engines/claude/compatibility/runtime.js';
import { createLogger } from '../src/utils/logger.js';

const PDF_MARKER = 'ORBBEC-7429';
const IMAGE_ANSWERS = ['Metabot', '17:17', 'Metabot'] as const;

export interface SmokeTurnEvidence {
  answer: string;
  cacheReadTokens: number;
  readToolUses: number;
  errors: string[];
}

export interface SmokeEvidence {
  profileId: string;
  model: string;
  sessionId: string;
  imageTurns: [SmokeTurnEvidence, SmokeTurnEvidence, SmokeTurnEvidence];
  pdfTurn: SmokeTurnEvidence;
  historicalImageHashes: string[];
}

function imageKey(mediaType: string, data: string): string {
  return `${mediaType}:${createHash('sha256').update(data).digest('hex')}`;
}

function collectImages(value: unknown, hashes: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectImages(item, hashes);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const object = value as Record<string, unknown>;
  if (object.type === 'image' && object.source && typeof object.source === 'object') {
    const source = object.source as Record<string, unknown>;
    if (
      source.type === 'base64'
      && typeof source.media_type === 'string'
      && typeof source.data === 'string'
    ) {
      hashes.push(imageKey(source.media_type, source.data));
    }
  }
  for (const nested of Object.values(object)) collectImages(nested, hashes);
}

export function extractUserImageHashes(jsonl: string): string[] {
  const hashes: string[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type !== 'user') continue;
      collectImages(record.message, hashes);
    } catch {
      // Ignore a partial final line; the PTY scanner follows the same rule.
    }
  }
  return hashes;
}

function pdfEscape(text: string): string {
  return text.replace(/([\\()])/g, '\\$1');
}

export function createMarkerPdf(marker: string): Buffer {
  const stream = `BT\n/F1 18 Tf\n72 720 Td\n(${pdfEscape(marker)}) Tj\nET\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, 'ascii');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  body += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}

export function assertSmokeEvidence(evidence: SmokeEvidence): void {
  if (evidence.profileId !== OPUS_PROFILE.id) {
    throw new Error(`Unexpected compatibility profile: ${evidence.profileId}`);
  }
  if (evidence.model !== OPUS_PROFILE.allowedModels[0]) {
    throw new Error(`Unexpected model: ${evidence.model}`);
  }
  if (!evidence.sessionId) throw new Error('Persistent session id is missing');

  evidence.imageTurns.forEach((turn, index) => {
    if (turn.answer.trim() !== IMAGE_ANSWERS[index]) {
      throw new Error(`Image turn ${index + 1} returned an unexpected answer`);
    }
    if (turn.readToolUses < 1) {
      throw new Error(`Image turn ${index + 1} did not use Read`);
    }
  });
  if (
    evidence.imageTurns[1].cacheReadTokens <= 0
    && evidence.imageTurns[2].cacheReadTokens <= 0
  ) {
    throw new Error('No cache read tokens were observed by the third image turn');
  }
  if (!evidence.pdfTurn.answer.includes(PDF_MARKER)) {
    throw new Error('PDF marker was not returned');
  }
  if (evidence.pdfTurn.readToolUses < 1) throw new Error('PDF turn did not use Read');

  const errors = [...evidence.imageTurns, evidence.pdfTurn].flatMap((turn) => turn.errors);
  if (errors.length > 0) {
    const contentBlock = errors.some((error) => /content block/i.test(error));
    throw new Error(contentBlock ? 'Content block error observed' : 'Claude turn error observed');
  }
  const hashes = evidence.historicalImageHashes;
  if (hashes.length !== 3 || hashes[0] !== hashes[2] || hashes[0] === hashes[1]) {
    throw new Error('Persistent session image history hashes are not ordered or idempotent');
  }
}

async function collectTurn(stream: AsyncIterable<SDKMessage>): Promise<{
  evidence: SmokeTurnEvidence;
  sessionId: string;
}> {
  let answer = '';
  let sessionId = '';
  let cacheReadTokens = 0;
  let readToolUses = 0;
  const errors: string[] = [];

  for await (const message of stream) {
    if (message.session_id) sessionId = message.session_id;
    if (message.type === 'assistant') {
      for (const block of message.message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          answer = block.text.trim();
          if (/content block not found/i.test(block.text)) errors.push('Content block not found');
        }
        if (block.type === 'tool_use' && block.name === 'Read') readToolUses += 1;
      }
    }
    if (message.type === 'result') {
      for (const usage of Object.values(message.modelUsage ?? {})) {
        cacheReadTokens += usage.cacheReadTokens ?? 0;
      }
      if (message.is_error || message.subtype === 'error') {
        errors.push(...(message.errors ?? ['Claude result error']));
      }
      if (message.result && /content block not found/i.test(message.result)) {
        errors.push('Content block not found');
      }
    }
  }
  return {
    evidence: { answer, cacheReadTokens, readToolUses, errors },
    sessionId,
  };
}

async function runTurn(
  executor: PersistentClaudeExecutor,
  prompt: string,
  timeoutMs = 180_000,
): Promise<{ evidence: SmokeTurnEvidence; sessionId: string }> {
  const handle = executor.nextTurn(prompt);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void handle.abort();
      reject(new Error(`Smoke turn timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([collectTurn(handle.stream), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sessionJsonlPath(cwd: string, sessionId: string): string {
  const escaped = claudeProjectDirectoryName(cwd);
  return join(homedir(), '.claude', 'projects', escaped, `${sessionId}.jsonl`);
}

async function main(): Promise<void> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, '..');
  const imagePaths = [
    join(repoRoot, 'resources', 'demo-1.png'),
    join(repoRoot, 'resources', 'demo-2.png'),
    join(repoRoot, 'resources', 'demo-1.png'),
  ];
  const tempRoot = mkdtempSync(join(tmpdir(), 'metabot-opus-smoke-'));
  const pdfPath = join(tempRoot, 'marker.pdf');
  writeFileSync(pdfPath, createMarkerPdf(PDF_MARKER), { mode: 0o600 });

  const logger = createLogger(process.env.SMOKE_LOG_LEVEL ?? 'warn');
  const runtime = await startClaudeCompatibilityRuntime({
    profile: OPUS_PROFILE,
    logger,
    claudeExecutable: process.env.CLAUDE_EXECUTABLE_PATH,
    sourceSettingsPath: process.env.CLAUDE_SETTINGS_PATH,
  });
  setActiveClaudeCompatibilityRuntime(runtime);
  const executor = new PersistentClaudeExecutor({
    cwd: repoRoot,
    model: OPUS_PROFILE.allowedModels[0],
    logger,
    backend: 'pty',
    compatibilityProfile: OPUS_PROFILE,
    idleTimeoutMs: 0,
  });

  try {
    await executor.start();
    const imageTurns: SmokeTurnEvidence[] = [];
    let sessionId = '';
    for (let index = 0; index < imagePaths.length; index += 1) {
      const result = await runTurn(
        executor,
        `必须调用 Read 工具读取图片 ${JSON.stringify(imagePaths[index])}。只回复 ${IMAGE_ANSWERS[index]}，不要输出其他内容。`,
      );
      imageTurns.push(result.evidence);
      sessionId = result.sessionId || sessionId;
    }
    const pdf = await runTurn(
      executor,
      `必须调用 Read 工具读取 PDF ${JSON.stringify(pdfPath)}，并且只回复文件中的编号。`,
    );
    sessionId = pdf.sessionId || sessionId;
    if (!sessionId) throw new Error('Claude did not report a session id');

    const historicalImageHashes = extractUserImageHashes(
      readFileSync(sessionJsonlPath(repoRoot, sessionId), 'utf8'),
    );
    const evidence: SmokeEvidence = {
      profileId: OPUS_PROFILE.id,
      model: OPUS_PROFILE.allowedModels[0],
      sessionId,
      imageTurns: imageTurns as SmokeEvidence['imageTurns'],
      pdfTurn: pdf.evidence,
      historicalImageHashes,
    };
    assertSmokeEvidence(evidence);
    console.log(JSON.stringify({
      status: 'pass',
      profileId: evidence.profileId,
      model: evidence.model,
      imageTurns: evidence.imageTurns.length,
      cacheReadTokens: evidence.imageTurns.map((turn) => turn.cacheReadTokens),
      pdfMarker: PDF_MARKER,
      historicalImageCount: evidence.historicalImageHashes.length,
    }, null, 2));
  } finally {
    await executor.shutdown('smoke-complete').catch(() => undefined);
    clearActiveClaudeCompatibilityRuntime();
    await runtime.close().catch(() => undefined);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`Opus image session smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
