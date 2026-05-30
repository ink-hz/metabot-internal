/**
 * PtyClaudeSession — drives a REAL interactive `claude` TUI process via node-pty.
 *
 * Owns: process spawn, lifecycle, keystroke input, readiness detection, jsonl path.
 * Does NOT own: jsonl reading, message adapting, hooks.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
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

  /**
   * Pre-accept the per-folder trust dialog for `cwd` in ~/.claude.json.
   *
   * On the FIRST interactive run in a directory, `claude` shows a blocking
   * "Is this a project you trust?" prompt — even under
   * --dangerously-skip-permissions. That dialog renders a `❯` menu pointer,
   * which fools waitForReady()'s input-box detector: we then "type" the
   * prompt into the menu and the session is corrupted. metabot uses a fresh
   * per-chat working directory, so EVERY new chat's first turn would hit
   * this. Seeding `projects[cwd].hasTrustDialogAccepted = true` (exactly how
   * claude records an accepted dialog) suppresses it entirely.
   *
   * Best-effort + targeted: we read-modify-write only the single nested flag
   * so we don't clobber the rest of the file. Failures are logged, not fatal.
   */
  private ensureFolderTrusted(cwd: string): void {
    const cfgPath = path.join(os.homedir(), '.claude.json');
    try {
      let cfg: Record<string, any> = {};
      try {
        cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      } catch {
        // missing/empty/corrupt — start from an empty object
        cfg = {};
      }
      if (!cfg.projects || typeof cfg.projects !== 'object') cfg.projects = {};
      const entry = (cfg.projects[cwd] && typeof cfg.projects[cwd] === 'object')
        ? cfg.projects[cwd]
        : (cfg.projects[cwd] = {});
      if (entry.hasTrustDialogAccepted === true) return; // already trusted
      entry.hasTrustDialogAccepted = true;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      this.log.info({ cwd }, 'pty-session: pre-accepted folder trust in ~/.claude.json');
    } catch (err) {
      this.log.warn({ err, cwd }, 'pty-session: failed to pre-accept folder trust (may hit trust dialog)');
    }
  }

  private spawn(): void {
    const { opts } = this;
    this.ensureFolderTrusted(opts.cwd);
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

    // Build the child env: process.env + caller overrides.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        if (v !== undefined) env[k] = v;
      }
    }
    // A PTY session is INTERACTIVE by definition. The parent (metabot) runs
    // under the Agent SDK, so its env carries CLAUDE_CODE_ENTRYPOINT=sdk-cli /
    // CLAUDECODE. We MUST strip those so the spawned `claude` uses the
    // interactive entrypoint marker — that marker is what selects the Claude
    // Code SUBSCRIPTION billing pool (vs the Agent-SDK credit pool) post
    // June-2026. ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN are deliberately
    // KEPT so traffic still routes through TeamClaude for Max-account load
    // balancing — the entrypoint marker passes through that transparent proxy.
    for (const k of ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE']) {
      delete env[k];
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
      try {
        this.opts.onExit?.({ exitCode, signal });
      } catch (err) {
        this.log.warn({ err }, 'pty-session: onExit callback threw');
      }
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

  /**
   * Write raw bytes to the PTY without any prompt-submit framing. Used by the
   * interactive-tool keystroke layer to drive native TUI menus (AskUserQuestion
   * / ExitPlanMode): digit selects, arrow keys navigate, `\r` confirms. Unlike
   * typePrompt(), this does NOT wait/double-Enter — the caller composes the
   * exact key sequence.
   */
  sendKeys(data: string): void {
    if (!this.term || this.disposed) return;
    this.term.write(data);
  }

  /**
   * Return an ANSI-stripped snapshot of the recent PTY output ring. The
   * keystroke layer parses this to detect a rendered menu and (for the dynamic
   * ExitPlanMode menu) locate which numbered option to press. Control bytes and
   * SGR/cursor/OSC escapes are removed so simple text regexes work.
   */
  snapshot(): string {
    return this.ring
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b[()][AB0]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
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
