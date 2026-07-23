import type { RecordEventInput } from './index.js';


export interface IdentityBackfillCandidate {
  botId: string;
  chatId: string;
  conversationType: 'direct' | 'group';
  turnId: string;
  openId?: string;
  unionId?: string;
}

export interface IdentityBackfillResult {
  attempted: number;
  resolved: number;
  skipped: number;
  failed: number;
}

interface IdentityBackfillDependencies {
  resolveDisplayName(candidate: IdentityBackfillCandidate): Promise<string | undefined>;
  recordIdentityObserved(input: RecordEventInput): void;
  warn?: (context: Record<string, unknown>, message: string) => void;
  now?: () => Date;
}


export async function backfillIdentityCandidates(
  candidates: Iterable<IdentityBackfillCandidate>,
  dependencies: IdentityBackfillDependencies,
): Promise<IdentityBackfillResult> {
  const result: IdentityBackfillResult = { attempted: 0, resolved: 0, skipped: 0, failed: 0 };
  const now = dependencies.now ?? (() => new Date());
  for (const candidate of candidates) {
    result.attempted += 1;
    try {
      const displayName = (await dependencies.resolveDisplayName(candidate))?.trim();
      if (!displayName) {
        result.skipped += 1;
        continue;
      }
      dependencies.recordIdentityObserved({
        botId: candidate.botId,
        turnId: candidate.turnId,
        runId: null,
        sender: {
          provider: 'feishu',
          ...(candidate.openId ? { open_id: candidate.openId } : {}),
          ...(candidate.unionId ? { union_id: candidate.unionId } : {}),
          display_name: displayName,
          attributes: {
            source: 'feishu_chat_members_backfill',
            observed_at: now().toISOString(),
          },
        },
        conversation: {
          platform: 'feishu',
          platform_id: candidate.chatId,
          type: candidate.conversationType,
        },
        payload: {},
      });
      result.resolved += 1;
    } catch {
      result.failed += 1;
      dependencies.warn?.({ result: 'failed' }, 'Feishu identity backfill candidate failed');
    }
  }
  return result;
}
