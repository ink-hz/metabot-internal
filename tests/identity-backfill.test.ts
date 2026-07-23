import { describe, expect, it, vi } from 'vitest';
import { backfillIdentityCandidates } from '../src/flywheel/identity-backfill.js';


describe('Feishu identity backfill', () => {
  it('records a safe identity observation for a resolved historical sender', async () => {
    const recordIdentityObserved = vi.fn();
    const result = await backfillIdentityCandidates(
      [{
        botId: 'marketing-inbound-bot',
        chatId: 'oc_chat',
        conversationType: 'group',
        turnId: '7cb9f46f-7ed1-43ae-9c50-87cb52d73dbb',
        openId: 'ou_sender',
        unionId: 'on_sender',
      }],
      {
        resolveDisplayName: async () => ' Lina ',
        recordIdentityObserved,
      },
    );

    expect(result).toEqual({ attempted: 1, resolved: 1, skipped: 0, failed: 0 });
    expect(recordIdentityObserved).toHaveBeenCalledWith({
      botId: 'marketing-inbound-bot',
      turnId: '7cb9f46f-7ed1-43ae-9c50-87cb52d73dbb',
      runId: null,
      sender: {
        provider: 'feishu',
        open_id: 'ou_sender',
        union_id: 'on_sender',
        display_name: 'Lina',
        attributes: expect.objectContaining({ source: 'feishu_chat_members_backfill' }),
      },
      conversation: { platform: 'feishu', platform_id: 'oc_chat', type: 'group' },
      payload: {},
    });
  });

  it('skips unresolved members and isolates lookup failures', async () => {
    const warn = vi.fn();
    const candidates = [
      { botId: 'hr-bot', chatId: 'first', conversationType: 'direct' as const, turnId: 't1', openId: 'one' },
      { botId: 'hr-bot', chatId: 'second', conversationType: 'direct' as const, turnId: 't2', openId: 'two' },
    ];
    const result = await backfillIdentityCandidates(candidates, {
      resolveDisplayName: async (candidate) => {
        if (candidate.chatId === 'first') return undefined;
        throw new Error('raw-provider-id-must-not-log');
      },
      recordIdentityObserved: vi.fn(),
      warn,
    });

    expect(result).toEqual({ attempted: 2, resolved: 0, skipped: 1, failed: 1 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('raw-provider-id-must-not-log');
  });
});
