import { describe, expect, it, vi } from 'vitest';
import {
  buildFlywheelMessageRecord,
  buildFlywheelRawEventRecord,
  createEventDispatcher,
} from '../src/feishu/event-handler.js';
import { ProbeReceiptStore } from '../src/reliability/probe-receipt-store.js';

describe('Feishu flywheel normalization', () => {
  it('keeps global identity, reply relation, attachment metadata and full L1 content', () => {
    const content = '完整中文正文😀'.repeat(20_000);
    const result = buildFlywheelMessageRecord({
      sender: { sender_id: { union_id: 'union-1', open_id: 'open-1' } },
      message: { parent_id: 'parent-1', content: '{"file_size":1234,"mime_type":"application/pdf"}' },
    }, {
      messageId: 'message-1', chatId: 'chat-1', chatType: 'p2p', userId: 'open-1',
      text: content, fileKey: 'file-1', fileName: 'report.pdf',
    }, 'hr-bot');

    expect(result.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.sender).toEqual({ provider: 'feishu', union_id: 'union-1', open_id: 'open-1' });
    expect(result.conversation).toEqual({ platform: 'feishu', platform_id: 'chat-1', type: 'direct' });
    expect(result.payload).toMatchObject({
      platform_message_id: 'message-1',
      reply_to_platform_message_id: 'parent-1',
      content,
      attachments: [{
        kind: 'file', name: 'report.pdf', platform_ref: 'file-1',
        size_bytes: 1234, mime_type: 'application/pdf',
      }],
    });
    expect(result.payload.content).toBe(content);
  });

  it('builds L3 raw-event evidence at the same collection point', () => {
    const raw = { sender: { sender_id: { union_id: 'union-1', open_id: 'open-1' } }, message: { content: '{"text":"raw"}' } };
    const message = buildFlywheelMessageRecord(raw, {
      messageId: 'message-1', chatId: 'chat-1', chatType: 'p2p', userId: 'open-1', text: 'raw',
    }, 'hr-bot');
    expect(buildFlywheelRawEventRecord(raw, message)).toMatchObject({
      turnId: message.turnId,
      runId: null,
      payload: { kind: 'raw_event', raw },
    });
  });

  it('preserves available metadata for primary, rich-post and batched media', () => {
    const result = buildFlywheelMessageRecord({ message: { content: '{}' } }, {
      messageId: 'message-media', chatId: 'chat-1', chatType: 'p2p', userId: 'open-1', text: 'media',
      imageKey: 'primary-image', mimeType: 'image/png', sizeBytes: 10,
      extraMedia: [
        { messageId: 'rich-image', imageKey: 'rich-image', mimeType: 'image/jpeg', sizeBytes: 20 },
        { messageId: 'batch-file', fileKey: 'batch-file', fileName: 'a.zip', mimeType: 'application/zip', sizeBytes: 30 },
      ],
    }, 'pc-bot');

    expect(result.payload.attachments).toEqual([
      { kind: 'image', platform_ref: 'primary-image', mime_type: 'image/png', size_bytes: 10 },
      { kind: 'image', platform_ref: 'rich-image', mime_type: 'image/jpeg', size_bytes: 20 },
      { kind: 'file', name: 'a.zip', platform_ref: 'batch-file', mime_type: 'application/zip', size_bytes: 30 },
    ]);
  });

  it('copies synthetic context into Recorder input without putting it in content', () => {
    const result = buildFlywheelMessageRecord({
      sender: { sender_id: { union_id: 'on_test', open_id: 'ou_test' } },
      message: { content: '{"text":"probe"}' },
    }, {
      messageId: 'message-probe',
      chatId: 'oc_canary',
      chatType: 'p2p',
      userId: 'ou_test',
      text: 'probe',
      syntheticProbe: {
        isSynthetic: true,
        probeId: '01J2Z9K2E8F5G9M6W4Q3T7R8Y1',
        attemptId: '01J2Z9M77A68K8B1T4W5F6H9P0',
      },
    }, 'hr-bot');

    expect(result).toMatchObject({
      isSynthetic: true,
      probeId: '01J2Z9K2E8F5G9M6W4Q3T7R8Y1',
      payload: { content: 'probe' },
    });
    expect(result.payload).not.toHaveProperty('syntheticProbe');
  });

  it('classifies before Recorder and removes the control marker from Agent content', async () => {
    const probeId = '01J2Z9K2E8F5G9M6W4Q3T7R8Y1';
    const attemptId = '01J2Z9M77A68K8B1T4W5F6H9P0';
    const order: string[] = [];
    let recorded: any;
    let delivered: any;
    const receipts = new ProbeReceiptStore();
    const recordMessageReceived = vi.fn((record) => {
      order.push('record');
      recorded = record;
    });
    const onMessage = vi.fn((message) => {
      order.push('message');
      delivered = message;
    });
    const dispatcher = createEventDispatcher(
      {
        name: 'hr-bot',
        feishu: { appId: 'app', appSecret: 'secret' },
        claude: {
          defaultWorkingDirectory: '/tmp', maxTurns: undefined,
          maxBudgetUsd: undefined, model: 'claude-opus-4-8', apiKey: undefined,
          outputsBaseDir: '/tmp/outputs', downloadsDir: '/tmp/downloads', backend: 'pty',
        },
      },
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      onMessage,
      undefined,
      undefined,
      undefined,
      {
        recordMessageReceived,
        recordEvidence: vi.fn(),
      } as never,
      { unionIds: new Set(['on_test']), chatIds: new Set(['oc_canary']) },
      receipts,
    );

    await dispatcher.invoke({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_id: { union_id: 'on_test', open_id: 'ou_test' } },
        message: {
          message_type: 'text',
          message_id: 'om_probe',
          chat_id: 'oc_canary',
          chat_type: 'p2p',
          content: JSON.stringify({
            text: `[metabot-probe id=${probeId} attempt=${attemptId}] 请回复 nonce=N-123`,
          }),
        },
      },
    }, { needCheck: false });

    expect(recordMessageReceived).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledOnce();
    expect(order).toEqual(['record', 'message']);
    expect(recorded.payload.content).toBe('请回复 nonce=N-123');
    expect(recorded).toMatchObject({ isSynthetic: true, probeId });
    expect(delivered.text).toBe('请回复 nonce=N-123');
    expect(delivered.syntheticProbe).toEqual({
      isSynthetic: true, probeId, attemptId,
    });
    expect(receipts.getAttempt(probeId, attemptId)?.stages).toEqual([{
      stage: 'feishu_received',
      at: expect.any(String),
      botName: 'hr-bot',
      messageId: 'om_probe',
    }]);
  });

  it('delivers the message before asynchronously recording the Feishu display name', async () => {
    let resolveName!: (name: string) => void;
    const name = new Promise<string>((resolve) => { resolveName = resolve; });
    const recordIdentityObserved = vi.fn();
    const onMessage = vi.fn();
    const dispatcher = createEventDispatcher(
      {
        name: 'hr-bot',
        feishu: { appId: 'app', appSecret: 'secret' },
        claude: {
          defaultWorkingDirectory: '/tmp', maxTurns: undefined,
          maxBudgetUsd: undefined, model: 'claude-opus-4-8', apiKey: undefined,
          outputsBaseDir: '/tmp/outputs', downloadsDir: '/tmp/downloads', backend: 'pty',
        },
      },
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      onMessage,
      undefined,
      { getChatMemberDisplayName: vi.fn(() => name) } as never,
      undefined,
      {
        recordMessageReceived: vi.fn(),
        recordEvidence: vi.fn(),
        recordIdentityObserved,
      } as never,
    );

    await dispatcher.invoke({
      schema: '2.0',
      header: { event_type: 'im.message.receive_v1' },
      event: {
        sender: { sender_id: { union_id: 'on_sender', open_id: 'ou_sender' } },
        message: {
          message_type: 'text', message_id: 'om_identity', chat_id: 'oc_identity',
          chat_type: 'p2p', content: JSON.stringify({ text: 'hello' }),
        },
      },
    }, { needCheck: false });

    expect(onMessage).toHaveBeenCalledOnce();
    expect(recordIdentityObserved).not.toHaveBeenCalled();

    resolveName('Lina');
    await name;
    await Promise.resolve();
    expect(recordIdentityObserved).toHaveBeenCalledWith(expect.objectContaining({
      botId: 'hr-bot',
      sender: expect.objectContaining({
        union_id: 'on_sender', open_id: 'ou_sender', display_name: 'Lina',
      }),
      payload: {},
    }));
    expect(JSON.stringify(recordIdentityObserved.mock.calls)).not.toContain('hello');
  });
});
