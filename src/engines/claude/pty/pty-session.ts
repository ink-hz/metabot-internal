/**
 * PtyClaudeSession — drives a REAL interactive `claude` TUI process via node-pty.
 *
 * Owns: process spawn, lifecycle, keystroke input, readiness detection, jsonl path.
 * Does NOT own: jsonl reading, message adapting, hooks.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import type { Logger } from '../../../utils/logger.js';
import type {
  PtyClaudeSession as IPtyClaudeSession,
  PtyClaudeSessionOptions,
} from './contract.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Max bytes kept in the PTY output ring buffer. */
const RING_CAP = 64 * 1024;

class PtyClaudeSessionImpl implements IPtyClaudeSession {
  readonly sessionId: string;
  readonly jsonlPath: string;

  private term: IPty | null = null;
  private ring = '';
  private readyPromise: Promise<void> | null = null;
  private disposed = false;
  private readonly log: Logger;
  private readonly opts: PtyClaudeSessionOptions;

  constructor(opts: PtyClaudeSessionOptions) {
    this.opts = opts;
    this.log = opts.logger;

    // Session id: adopt resume id or self-generate.
    this.sessionId = opts.resume ?? randomUUID();

    // Compute jsonl path: ~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl
    // Escaped cwd: every '/' replaced by '-' (leading slash → leading dash).
    const escaped = opts.cwd.replace(/\//g, '-');
    this.jsonlPath = path.join(
      os.homedir(),
      '.claude',
      'projects',
      escaped,
      `${this.sessionId}.jsonl`,
    );

    this.spawn();
  }

  private spawn(): void {
    const { opts } = this;
    const args: string[] = [];

    if (opts.resume) {
      args.push('--resume', opts.resume);
    } else {
      args.push('--session-id', this.sessionId);
    }

    args.push('--settings', opts.settingsPath);
    args.push('--dangerously-skip-permissions');

    if (opts.appendSystemPrompt) {
      args.push('--append-system-prompt', opts.appendSystemPrompt);
    }
    if (opts.model) {
      args.push('--model', opts.model);
    }

    // Build a clean env: merge caller env on top of process.env, then strip
    // gateway/SDK vars so claude uses the interactive subscription pool.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (v !== undefined) env[k] = v;
      }
    }

    const claudePath = opts.pathToClaudeExecutable ?? 'claude';
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;

    this.log.info({ sessionId: this.sessionId, args, cwd: opts.cwd }, 'pty-session: spawning claude');

    this.term = pty.spawn(claudePath, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env,
    });

    this.term.onData((data: string) => {
      this.ring += data;
      if (this.ring.length > RING_CAP) {
        this.ring = this.ring.slice(-RING_CAP);
      }
    });

    this.term.onExit(({ exitCode, signal }) => {
      this.log.info({ exitCode, signal }, 'pty-session: claude process exited');
    });
  }

  ready(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.waitForReady();
    return this.readyPromise;
  }

  private async waitForReady(): Promise<void> {
    const TIMEOUT = 30_000;
    const POLL = 150;
    const SETTLE = 2500;
    const start = Date.now();

    while (Date.now() - start < TIMEOUT) {
      if (/❯/.test(this.ring)) {
        this.log.info('pty-session: TUI input box detected, settling...');
        await sleep(SETTLE);
        return;
      }
      await sleep(POLL);
    }

    throw new Error(
      `pty-session: timeout (${TIMEOUT}ms) waiting for TUI input box (❯). ` +
        `Last 500 chars: ${this.ring.slice(-500)}`,
    );
  }

  async typePrompt(text: string): Promise<void> {
    await this.ready();
    if (!this.term || this.disposed) {
      throw new Error('pty-session: cannot type — session disposed');
    }

    this.log.info({ len: text.length }, 'pty-session: typing prompt');

    // Type char-by-char into the PTY (interactive input).
    for (const ch of text) {
      this.term.write(ch);
    }

    await sleep(800);
    this.term.write('\r');
    await sleep(1500);
    // Double-Enter safeguard: the TUI sometimes needs a second Enter to submit.
    this.term.write('\r');
  }

  async interrupt(): Promise<void> {
    if (!this.term || this.disposed) return;
    this.log.info('pty-session: sending interrupt (ESC + Ctrl-C)');
    this.term.write('\x1b');
    await sleep(100);
    this.term.write('\x03');
    await sleep(100);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.term) return;

    this.log.info('pty-session: disposing');
    this.term.write('\x03');
    await sleep(300);
    this.term.kill();
    this.term = null;
  }
}

/** Factory: create a PtyClaudeSession from options. */
export function createPtyClaudeSession(
  options: PtyClaudeSessionOptions,
): IPtyClaudeSession {
  return new PtyClaudeSessionImpl(options);
}
