import * as fs from 'node:fs';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';
import type { DeliveryReceipt } from '../reliability/probe-types.js';

interface MessageSenderOptions {
  now?: () => number;
  identityCacheTtlMs?: number;
}

const DEFAULT_IDENTITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class MessageSender {
  private readonly identityCache = new Map<string, { name: string; observedAt: number }>();
  private readonly now: () => number;
  private readonly identityCacheTtlMs: number;

  constructor(
    private client: lark.Client,
    private logger: Logger,
    options: MessageSenderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.identityCacheTtlMs = options.identityCacheTtlMs ?? DEFAULT_IDENTITY_CACHE_TTL_MS;
  }

  async getChatMemberDisplayName(chatId: string, openId: string): Promise<string | undefined> {
    const cacheKey = `${chatId}\u0000${openId}`;
    const cached = this.identityCache.get(cacheKey);
    if (cached && this.now() - cached.observedAt < this.identityCacheTtlMs) return cached.name;

    try {
      const pages = await this.client.im.v1.chatMembers.getWithIterator({
        params: { member_id_type: 'open_id', page_size: 100 },
        path: { chat_id: chatId },
      });
      for await (const page of pages) {
        const member = page?.items?.find((item) => item.member_id === openId);
        const name = member?.name?.trim();
        if (name) {
          this.identityCache.set(cacheKey, { name, observedAt: this.now() });
          return name;
        }
      }
      return undefined;
    } catch {
      this.logger.warn({ result: 'failed' }, 'Feishu sender identity lookup failed');
      return undefined;
    }
  }

  async sendCard(chatId: string, cardContent: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: cardContent,
          msg_type: 'interactive',
        },
      });

      const messageId = resp?.data?.message_id;
      if (!messageId) {
        this.logger.error({ resp }, 'Failed to get message_id from send response');
      }
      return messageId;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send card');
      return undefined;
    }
  }

  async updateCard(messageId: string, cardContent: string): Promise<boolean> {
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: cardContent },
      });
      return true;
    } catch (err) {
      this.logger.error({ err, messageId }, 'Failed to update card');
      return false;
    }
  }

  async downloadImage(messageId: string, imageKey: string, savePath: string): Promise<boolean> {
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: { type: 'image' },
      });

      if (resp) {
        await (resp as any).writeFile(savePath);
        this.logger.info({ messageId, imageKey, savePath }, 'Image downloaded');
        return true;
      }
      this.logger.error({ messageId, imageKey }, 'Empty response when downloading image');
      return false;
    } catch (err) {
      this.logger.error({ err, messageId, imageKey }, 'Failed to download image');
      return false;
    }
  }

  async downloadFile(messageId: string, fileKey: string, savePath: string): Promise<boolean> {
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      });

      if (resp) {
        await (resp as any).writeFile(savePath);
        this.logger.info({ messageId, fileKey, savePath }, 'File downloaded');
        return true;
      }
      this.logger.error({ messageId, fileKey }, 'Empty response when downloading file');
      return false;
    } catch (err) {
      this.logger.error({ err, messageId, fileKey }, 'Failed to download file');
      return false;
    }
  }

  async uploadImage(filePath: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.image.create({
        data: {
          image_type: 'message',
          image: fs.createReadStream(filePath),
        },
      });
      const imageKey = resp?.image_key;
      if (imageKey) {
        this.logger.info({ filePath, imageKey }, 'Image uploaded to Feishu');
      }
      return imageKey;
    } catch (err) {
      this.logger.error({ err, filePath }, 'Failed to upload image');
      return undefined;
    }
  }

  async sendImage(chatId: string, imageKey: string): Promise<boolean> {
    return (await this.sendImageWithReceipt(chatId, imageKey)).ok;
  }

  async sendImageWithReceipt(chatId: string, imageKey: string): Promise<DeliveryReceipt> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ image_key: imageKey }),
          msg_type: 'image',
        },
      });
      const messageId = resp?.data?.message_id;
      return messageId
        ? { ok: true, kind: 'image', messageId, fileKey: imageKey }
        : { ok: false, kind: 'image', fileKey: imageKey };
    } catch (err) {
      this.logger.error({ err, chatId, imageKey }, 'Failed to send image');
      return { ok: false, kind: 'image', fileKey: imageKey };
    }
  }

  async sendImageFile(chatId: string, filePath: string): Promise<boolean> {
    return (await this.sendImageFileWithReceipt(chatId, filePath)).ok;
  }

  async sendImageFileWithReceipt(chatId: string, filePath: string): Promise<DeliveryReceipt> {
    const imageKey = await this.uploadImage(filePath);
    if (!imageKey) return { ok: false, kind: 'image' };
    return this.sendImageWithReceipt(chatId, imageKey);
  }

  async uploadFile(filePath: string, fileName: string, fileType: string): Promise<string | undefined> {
    try {
      const resp = await this.client.im.v1.file.create({
        data: {
          file_type: fileType as any,
          file_name: fileName,
          file: fs.createReadStream(filePath),
        },
      });
      const fileKey = resp?.file_key;
      if (fileKey) {
        this.logger.info({ filePath, fileKey, fileType }, 'File uploaded to Feishu');
      }
      return fileKey;
    } catch (err) {
      this.logger.error({ err, filePath, fileType }, 'Failed to upload file');
      return undefined;
    }
  }

  async sendFile(chatId: string, fileKey: string): Promise<boolean> {
    return (await this.sendFileWithReceipt(chatId, fileKey)).ok;
  }

  async sendFileWithReceipt(
    chatId: string,
    fileKey: string,
    fileName?: string,
  ): Promise<DeliveryReceipt> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ file_key: fileKey }),
          msg_type: 'file',
        },
      });
      const messageId = resp?.data?.message_id;
      return messageId
        ? { ok: true, kind: 'file', messageId, fileKey, ...(fileName ? { fileName } : {}) }
        : { ok: false, kind: 'file', fileKey, ...(fileName ? { fileName } : {}) };
    } catch (err) {
      this.logger.error({ err, chatId, fileKey }, 'Failed to send file');
      return { ok: false, kind: 'file', fileKey, ...(fileName ? { fileName } : {}) };
    }
  }

  async sendLocalFile(chatId: string, filePath: string, fileName: string, fileType: string): Promise<boolean> {
    return (await this.sendLocalFileWithReceipt(chatId, filePath, fileName, fileType)).ok;
  }

  async sendLocalFileWithReceipt(
    chatId: string,
    filePath: string,
    fileName: string,
    fileType: string,
  ): Promise<DeliveryReceipt> {
    const fileKey = await this.uploadFile(filePath, fileName, fileType);
    if (!fileKey) return { ok: false, kind: 'file', fileName };
    return this.sendFileWithReceipt(chatId, fileKey, fileName);
  }

  async sendAudio(chatId: string, fileKey: string): Promise<boolean> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ file_key: fileKey }),
          msg_type: 'audio',
        },
      });
      return true;
    } catch (err) {
      this.logger.error({ err, chatId, fileKey }, 'Failed to send audio');
      return false;
    }
  }

  async sendAudioFile(chatId: string, filePath: string, fileName: string): Promise<boolean> {
    const fileKey = await this.uploadFile(filePath, fileName, 'opus');
    if (!fileKey) return false;
    return this.sendAudio(chatId, fileKey);
  }

  async getChatMemberCount(chatId: string): Promise<number | undefined> {
    try {
      const resp: any = await this.client.im.v1.chat.get({
        path: { chat_id: chatId },
      });
      const userCount = parseInt(resp?.data?.user_count, 10) || 0;
      const botCount = parseInt(resp?.data?.bot_count, 10) || 0;
      return userCount + botCount;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to get chat member count');
      return undefined;
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send text');
    }
  }
}
