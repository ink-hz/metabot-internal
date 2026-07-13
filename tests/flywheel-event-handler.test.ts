import { describe, expect, it } from 'vitest';
import { buildFlywheelMessageRecord, buildFlywheelRawEventRecord } from '../src/feishu/event-handler.js';

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
});
