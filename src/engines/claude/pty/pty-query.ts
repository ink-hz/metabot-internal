/**
 * PTY backend — ptyQuery(): drop-in replacement for the Agent SDK's query().
 *
 * Shaped identically at the call site in persistent-executor.ts:
 *   const stream = ptyQuery({ prompt: this.inputQueue, options: queryOptions });
 *   // stream is async-iterable<SDKMessage> AND has .interrupt()
 *
 * It wires together the three W1/W2 modules:
 *   - PtyClaudeSession  — drives a REAL interactive `claude` process (no -p),
 *     so the turn bills against the Claude Code subscription pool (via
 *     TeamClaude for load balancing) rather than the Agent SDK credit pool.
 *   - JsonlScanner      — tails the session jsonl, yielding raw records.
 *   - messageAdapter    — raw record → SDKMessage (the shape stream-processor
 *     already understands).
 *   - PtyHookBridge     — settings.json command hooks; the Stop hook fires
 *     onTurnComplete, which we turn into a synthesized terminal `result`
 *     SDKMessage (interactive jsonl has no explicit result line).
 *
 * Concurrency model: one unified AsyncQueue<SDKMessage> (`out`) is the single
 * output channel the caller iterates. Three detached loops feed/drive it:
 *   1. scanner loop  — adapts jsonl records into `out`, tracking usage/session.
 *   2. prompt loop   — consumes the input prompt iterable, typing each user
 *                      message into the TUI (one turn per message).
 *   3. turn-complete — on each Stop-hook fire, after a short drain delay (so
 *                      the scanner flushes the turn's final lines), emit the
 *                      synthesized `result`.
 */

import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '../executor.js';
import { AsyncQueue } from '../../../utils/async-queue.js';
import type {
  PtyQuery,
  PtyQueryOptions,
  PtyPromptSource,
  PtyUserMessage,
  PtyHookBridge,
  RawJsonlRecord,
} from './contract.js';
import { createPtyClaudeSession } from './pty-session.js';
import { createJsonlScanner } from './jsonl-scanner.js';
import { adaptJsonlRecord, synthesizeResult } from './message-adapter.js';
import { createHookBridge } from './hook-bridge.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Drain delay after a Stop-hook fires before synthesizing the `result`. The
 * scanner polls every ~120ms; this gives it room to read the turn's final
 * assistant line(s) so the `result` is ordered AFTER them. Matches the POC's
 * proven ~500ms settle.
 */
const RESULT_DRAIN_MS = 450;

/** Extract a typeable prompt string from an input user message, or null. */
function extractPromptText(m: PtyUserMessage): string | null {
  const content = m.message?.content;
  if (typeof content === 'string') {
    return content.trim() ? content : null;
  }
  if (Array.isArray(content)) {
    const texts = content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string);
    if (texts.length > 0) return texts.join('\n');
    // tool_result-only message (e.g. AskUserQuestion answer fallback): cannot
    // be reliably injected via keystrokes in phase 1. See contract phase-2 note.
    return null;
  }
  return null;
}

/** Accumulated per-turn usage pulled off the latest assistant jsonl record. */
interface UsageAccum {
  inputTokens?: number;
  outputTokens?: number;
}

export const ptyQuery = (args: {
  prompt: PtyPromptSource;
  options: PtyQueryOptions;
}): PtyQuery => {
  const { prompt, options } = args;
  const { logger } = options;

  // The single output channel the caller iterates.
  const out = new AsyncQueue<SDKMessage>();

  // Hook bridge: owns settings.json + Stop/team-event command hooks.
  const hookBridge: PtyHookBridge = options.hookBridge ?? createHookBridge();

  // Mutable per-run state.
  let sessionId = options.resume ?? '';
  let lastUsage: UsageAccum = {};
  let disposed = false;
  let session: ReturnType<typeof createPtyClaudeSession> | null = null;
  let scanner: ReturnType<typeof createJsonlScanner> | null = null;

  // Map the SDK-style systemPrompt ({type:'preset', append}) → --append flag.
  let appendSystemPrompt: string | undefined;
  const sp = options.systemPrompt;
  if (typeof sp === 'string') appendSystemPrompt = sp;
  else if (sp && typeof sp === 'object' && typeof sp.append === 'string') appendSystemPrompt = sp.append;

  // ── Boot: write settings, spawn session, start scanner ───────────────────
  const boot = (async () => {
    const settingsPath = await hookBridge.writeSettings();

    session = createPtyClaudeSession({
      cwd: options.cwd,
      resume: options.resume,
      model: options.model,
      appendSystemPrompt,
      settingsPath,
      env: options.env,
      pathToClaudeExecutable: options.pathToClaudeExecutable,
      cols: options.cols,
      rows: options.rows,
      logger,
    });
    if (!sessionId) sessionId = session.sessionId;

    scanner = createJsonlScanner({ jsonlPath: session.jsonlPath, logger });

    // Stop-hook → synthesize a terminal `result` after a short drain delay.
    hookBridge.onTurnComplete(() => {
      if (disposed) return;
      const usage = { ...lastUsage };
      // Reset for the next turn.
      lastUsage = {};
      setTimeout(() => {
        if (disposed) return;
        out.enqueue(
          synthesizeResult({
            sessionId,
            usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
          }),
        );
      }, RESULT_DRAIN_MS);
    });

    // Scanner loop: adapt each raw record into the output channel.
    void runScanner();
    // Prompt loop: type each enqueued user message into the TUI.
    void runPromptLoop();
  })();

  boot.catch((err) => {
    logger.error({ err }, 'ptyQuery: boot failed');
    out.finish();
  });

  // ── Scanner loop ─────────────────────────────────────────────────────────
  async function runScanner(): Promise<void> {
    if (!scanner) return;
    try {
      for await (const rec of scanner) {
        if (disposed) break;
        trackUsage(rec);
        if (!sessionId) {
          const sid = (rec.sessionId ?? rec.session_id) as string | undefined;
          if (sid) sessionId = sid;
        }
        const adapted = adaptJsonlRecord(rec);
        if (!adapted) continue;
        if (Array.isArray(adapted)) {
          for (const m of adapted) out.enqueue(m);
        } else {
          out.enqueue(adapted);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'ptyQuery: scanner loop ended with error');
    }
  }

  /** Pull token usage off an assistant record so synthesizeResult can report it. */
  function trackUsage(rec: RawJsonlRecord): void {
    if (rec.type !== 'assistant') return;
    const msg = rec.message as Record<string, unknown> | undefined;
    const usage = msg?.usage as Record<string, unknown> | undefined;
    if (!usage) return;
    const inT = usage.input_tokens as number | undefined;
    const outT = usage.output_tokens as number | undefined;
    if (typeof inT === 'number') lastUsage.inputTokens = inT;
    if (typeof outT === 'number') lastUsage.outputTokens = outT;
  }

  // ── Prompt loop ──────────────────────────────────────────────────────────
  async function runPromptLoop(): Promise<void> {
    try {
      for await (const userMsg of prompt) {
        if (disposed) break;
        const text = extractPromptText(userMsg as PtyUserMessage);
        if (text === null) {
          logger.warn(
            'ptyQuery: skipping non-typeable input message (tool_result/empty) — phase 2',
          );
          continue;
        }
        if (!session) await boot; // ensure session exists
        if (!session || disposed) break;
        await session.typePrompt(text);
      }
    } catch (err) {
      logger.warn({ err }, 'ptyQuery: prompt loop ended with error');
    }
    // Prompt source finished → no more turns will be started. Tear down.
    await dispose();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  async function interrupt(): Promise<void> {
    if (!session) {
      // Boot may still be in flight; wait briefly then try.
      try {
        await Promise.race([boot, sleep(2000)]);
      } catch {
        /* ignore */
      }
    }
    if (session) await session.interrupt();
  }

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    try {
      scanner?.stop();
    } catch {
      /* ignore */
    }
    try {
      await hookBridge.dispose();
    } catch {
      /* ignore */
    }
    try {
      await session?.dispose();
    } catch {
      /* ignore */
    }
    out.finish();
  }

  // ── The drop-in PtyQuery ─────────────────────────────────────────────────
  const query: PtyQuery = {
    [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
    interrupt,
    dispose,
  };
  return query;
};
