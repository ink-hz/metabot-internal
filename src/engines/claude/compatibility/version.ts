import { execFileSync } from 'node:child_process';
import type { ClaudeCompatibilityProfile } from './profile.js';

export type ClaudeVersionRunner = (executable: string, args: readonly string[]) => string;

const runClaudeVersion: ClaudeVersionRunner = (executable, args) =>
  execFileSync(executable, [...args], { encoding: 'utf8' });

export function assertCompatibleClaudeVersion(
  profile: ClaudeCompatibilityProfile,
  executable: string,
  runner: ClaudeVersionRunner = runClaudeVersion,
): void {
  const output = runner(executable, ['--version']);
  const actualVersion = output.match(
    /(?:^|[^0-9A-Za-z.-])(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?![0-9A-Za-z.+-])/,
  )?.[1];
  if (actualVersion !== profile.claudeCodeVersion) {
    throw new Error(
      `Claude Code compatibility profile ${profile.id} expected ${profile.claudeCodeVersion}, ` +
        `but ${executable} reported ${actualVersion ?? 'no semantic version'}`,
    );
  }
}
