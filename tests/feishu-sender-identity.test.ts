import { describe, expect, it, vi } from 'vitest';
import { MessageSender } from '../src/feishu/message-sender.js';

function asyncPages(pages: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const page of pages) yield page;
    },
  };
}

describe('MessageSender Feishu identity lookup', () => {
  it('selects the exact open_id across pages and caches the trimmed name', async () => {
    let now = 1_000;
    const getWithIterator = vi.fn(async () => asyncPages([
      { items: [{ member_id: 'ou_other', name: 'Wrong Person' }] },
      { items: [{ member_id: 'ou_target', name: '  Iris  ' }] },
    ]));
    const sender = new MessageSender(
      { im: { v1: { chatMembers: { getWithIterator } } } } as never,
      { warn: vi.fn() } as never,
      { now: () => now, identityCacheTtlMs: 24 * 60 * 60 * 1000 },
    );

    await expect(sender.getChatMemberDisplayName('oc_chat', 'ou_target')).resolves.toBe('Iris');
    await expect(sender.getChatMemberDisplayName('oc_chat', 'ou_target')).resolves.toBe('Iris');
    expect(getWithIterator).toHaveBeenCalledOnce();

    now += 24 * 60 * 60 * 1000 + 1;
    await expect(sender.getChatMemberDisplayName('oc_chat', 'ou_target')).resolves.toBe('Iris');
    expect(getWithIterator).toHaveBeenCalledTimes(2);
  });

  it('returns undefined without logging identity data when lookup fails', async () => {
    const warn = vi.fn();
    const sender = new MessageSender(
      { im: { v1: { chatMembers: { getWithIterator: vi.fn(async () => { throw new Error('ou_secret'); }) } } } } as never,
      { warn } as never,
    );

    await expect(sender.getChatMemberDisplayName('oc_secret', 'ou_secret')).resolves.toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/oc_secret|ou_secret/u);
  });
});
