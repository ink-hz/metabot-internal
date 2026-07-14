import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageSender } from '../src/feishu/message-sender.js';

describe('MessageSender delivery receipts', () => {
  const paths: string[] = [];
  afterEach(() => {
    for (const target of paths.splice(0)) fs.rmSync(target, { force: true });
  });

  it('returns upload and delivery identifiers for a local file', async () => {
    const filePath = path.join(os.tmpdir(), `metabot-receipt-${crypto.randomUUID()}.pdf`);
    fs.writeFileSync(filePath, '%PDF-1.7');
    paths.push(filePath);
    const createFile = vi.fn().mockImplementation(async ({ data }) => {
      for await (const _chunk of data.file) {
        // Consume the production ReadStream before fixture cleanup.
      }
      return { file_key: 'file_key_1' };
    });
    const createMessage = vi.fn().mockResolvedValue({ data: { message_id: 'om_out_1' } });
    const sender = new MessageSender({
      im: { v1: { file: { create: createFile }, message: { create: createMessage } } },
    } as never, { info: vi.fn(), error: vi.fn() } as never);

    await expect(sender.sendLocalFileWithReceipt(
      'oc_canary', filePath, 'trial.pdf', 'pdf',
    )).resolves.toEqual({
      ok: true,
      kind: 'file',
      messageId: 'om_out_1',
      fileKey: 'file_key_1',
      fileName: 'trial.pdf',
    });
  });

  it('does not claim delivery when Feishu omits the message id', async () => {
    const sender = new MessageSender({
      im: { v1: { message: { create: vi.fn().mockResolvedValue({ data: {} }) } } },
    } as never, { info: vi.fn(), error: vi.fn() } as never);

    await expect(sender.sendFileWithReceipt(
      'oc_canary', 'file_key_1', 'trial.pdf',
    )).resolves.toEqual({
      ok: false,
      kind: 'file',
      fileKey: 'file_key_1',
      fileName: 'trial.pdf',
    });
  });
});
