import * as lark from '@larksuiteoapi/node-sdk';
import type { BotConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { MessageSender } from './message-sender.js';
import { randomUUID } from 'node:crypto';
import type { FlywheelRecorder, RecordEventInput } from '../flywheel/index.js';
import type { ProbeReceiptStore } from '../reliability/probe-receipt-store.js';
import {
  classifySyntheticProbe,
  stripSyntheticControlMarker,
  type SyntheticAllowlist,
} from '../reliability/synthetic-context.js';

// Re-export from shared types so existing imports continue to work
export type { IncomingMessage } from '../types.js';
import type { IncomingMessage } from '../types.js';

export type MessageHandler = (msg: IncomingMessage) => void;

/** Payload delivered when a user clicks a button on an interactive card. */
export interface CardActionEvent {
  chatId: string;
  userId: string;
  messageId: string;
  /** Arbitrary value object set by the card builder on the clicked button. */
  value: Record<string, unknown>;
}

export type CardActionHandler = (event: CardActionEvent) => void;

// Cache for group member counts (to avoid calling Feishu API on every message)
const MEMBER_COUNT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const memberCountCache = new Map<string, { count: number; ts: number }>();

// Cache for recent media messages in group chats (file/image sent without @mention).
// When a user later @mentions the bot, cached media is attached automatically.
const MEDIA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
interface CachedMedia {
  messageId: string;
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  ts: number;
}
const pendingMediaCache = new Map<string, CachedMedia[]>(); // key: chatId:userId

function cacheMediaKey(chatId: string, userId: string): string {
  return `${chatId}:${userId}`;
}

function getCachedMedia(chatId: string, userId: string): CachedMedia[] {
  const key = cacheMediaKey(chatId, userId);
  const items = pendingMediaCache.get(key);
  if (!items) return [];
  const now = Date.now();
  const valid = items.filter(m => now - m.ts < MEDIA_CACHE_TTL_MS);
  if (valid.length === 0) {
    pendingMediaCache.delete(key);
    return [];
  }
  pendingMediaCache.set(key, valid);
  return valid;
}

function clearCachedMedia(chatId: string, userId: string): void {
  pendingMediaCache.delete(cacheMediaKey(chatId, userId));
}

async function isPrivateLikeGroup(chatId: string, sender: MessageSender): Promise<boolean> {
  const cached = memberCountCache.get(chatId);
  if (cached && Date.now() - cached.ts < MEMBER_COUNT_CACHE_TTL_MS) {
    return cached.count === 2;
  }
  const count = await sender.getChatMemberCount(chatId);
  if (count !== undefined) {
    memberCountCache.set(chatId, { count, ts: Date.now() });
    return count === 2;
  }
  return false;
}

export function createEventDispatcher(
  config: BotConfig,
  logger: Logger,
  onMessage: MessageHandler,
  botOpenId?: string,
  messageSender?: MessageSender,
  onCardAction?: CardActionHandler,
  flywheel?: FlywheelRecorder,
  syntheticAllowlist: SyntheticAllowlist = { unionIds: new Set(), chatIds: new Set() },
  probeReceiptStore?: ProbeReceiptStore,
): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});

  // Register the card action trigger handler (fired when a user clicks a button
  // on an interactive card). The lark SDK types omit this event so we cast.
  if (onCardAction) {
    (dispatcher as unknown as {
      register: (handlers: Record<string, (data: unknown) => unknown>) => void;
    }).register({
      'card.action.trigger': (data: unknown) => {
        try {
          const d = data as {
            operator?: { open_id?: string };
            action?: { value?: unknown };
            context?: { open_message_id?: string; open_chat_id?: string };
          };
          const userId = d.operator?.open_id;
          const messageId = d.context?.open_message_id;
          const chatId = d.context?.open_chat_id;
          const raw = d.action?.value;
          if (!userId || !messageId || !chatId || !raw || typeof raw !== 'object') {
            logger.warn({ data }, 'Card action missing required fields');
            return { toast: { type: 'error', content: 'Invalid card action' } };
          }
          onCardAction({
            chatId,
            userId,
            messageId,
            value: raw as Record<string, unknown>,
          });
          return { toast: { type: 'success', content: '已收到' } };
        } catch (err) {
          logger.error({ err }, 'Error handling card action');
          return { toast: { type: 'error', content: 'Internal error' } };
        }
      },
    });
  }

  dispatcher.register({
    'im.message.receive_v1': async (data: any) => {
      try {
        const event = data;
        const message = event.message;
        const sender = event.sender;

        const msgType = message.message_type;

        // Only handle text, post (rich text), image, and file messages
        if (msgType !== 'text' && msgType !== 'post' && msgType !== 'image' && msgType !== 'file') {
          logger.debug({ type: msgType }, 'Ignoring unsupported message type');
          return;
        }

        const userId = sender?.sender_id?.open_id;
        if (!userId) {
          logger.warn('Message missing sender open_id');
          return;
        }

        const chatId = message.chat_id;
        const chatType = message.chat_type;
        const messageId = message.message_id;

        // In group chats, only respond when the bot is @mentioned
        // Exceptions: 2-member groups are treated like DMs; groupNoMention mode skips @mention check
        const mentions = message.mentions;
        if (chatType === 'group') {
          const botMentioned = botOpenId
            ? mentions?.some((m: any) => m.id?.open_id === botOpenId)
            : mentions && mentions.length > 0;
          if (!botMentioned) {
            // groupNoMention mode: respond to all messages without @mention
            if (config.groupNoMention) {
              logger.debug({ chatId }, 'Group no-mention mode enabled, processing without @mention');
            } else if (messageSender && await isPrivateLikeGroup(chatId, messageSender)) {
              logger.debug({ chatId }, 'Private-like group (2 members), processing without @mention');
            } else if (msgType === 'image' || msgType === 'file') {
              // Cache media messages for later retrieval when user @mentions bot
              const media = parseMediaMessage(message, msgType, logger);
              if (media) {
                const key = cacheMediaKey(chatId, userId);
                const items = pendingMediaCache.get(key) || [];
                items.push({ ...media, messageId, ts: Date.now() });
                pendingMediaCache.set(key, items);
                logger.info({ chatId, userId, msgType, ...media }, 'Cached group media for later @mention');
              }
              return;
            } else {
              logger.debug('Ignoring group message without @mention');
              return;
            }
          }
        }

        let text = '';
        let imageKey: string | undefined;
        let fileKey: string | undefined;
        let fileName: string | undefined;
        let mimeType: string | undefined;
        let sizeBytes: number | undefined;
        let postExtraImages: Array<{ imageKey: string; mimeType?: string; sizeBytes?: number }> = [];

        if (msgType === 'image') {
          // Image message: extract image_key
          try {
            const content = JSON.parse(message.content);
            imageKey = content.image_key;
            mimeType = content.mime_type;
            sizeBytes = numericMetadata(content.file_size ?? content.size);
          } catch {
            logger.warn('Failed to parse image message content');
            return;
          }
          if (!imageKey) {
            logger.warn('Image message missing image_key');
            return;
          }
          text = '请分析这张图片';
          logger.info({ userId, chatId, chatType, imageKey }, 'Received image message');
        } else if (msgType === 'file') {
          // File message: extract file_key and file_name
          try {
            const content = JSON.parse(message.content);
            fileKey = content.file_key;
            fileName = content.file_name;
            mimeType = content.mime_type;
            sizeBytes = numericMetadata(content.file_size ?? content.size);
          } catch {
            logger.warn('Failed to parse file message content');
            return;
          }
          if (!fileKey || !fileName) {
            logger.warn('File message missing file_key or file_name');
            return;
          }
          text = '请分析这个文件';
          logger.info({ userId, chatId, chatType, fileKey, fileName }, 'Received file message');
        } else if (msgType === 'post') {
          // Rich text (post) message: extract plain text and images from nested structure
          try {
            const content = JSON.parse(message.content);
            logger.debug({ postContent: JSON.stringify(content).slice(0, 500) }, 'Raw post content');
            text = extractTextFromPost(content);
            const postImages = extractImagesFromPost(content);
            if (postImages.length > 0) {
              imageKey = postImages[0].imageKey;
              mimeType = postImages[0].mimeType;
              sizeBytes = postImages[0].sizeBytes;
              postExtraImages = postImages.slice(1);
            }
            logger.debug({ extractedText: text.slice(0, 200), imageKey, postImageCount: postImages.length }, 'Extracted post content');
          } catch {
            logger.warn({ content: message.content }, 'Failed to parse post message content');
            return;
          }
        } else {
          // Text message: extract and clean text
          try {
            const content = JSON.parse(message.content);
            text = content.text || '';
          } catch {
            logger.warn({ content: message.content }, 'Failed to parse message content');
            return;
          }
        }

        // Common text cleanup for text and post messages
        if (msgType === 'text' || msgType === 'post') {
          // Strip @mention tags (format: @_user_xxx or similar)
          text = text.replace(/@_\w+\s*/g, '').trim();

          // Strip Feishu auto-generated markdown links: [text](url) → text
          text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

          if (!text && !imageKey) {
            logger.debug('Empty message after stripping mentions');
            return;
          }

          // If text is empty but we have an image (e.g. @bot + image in group chat), set default prompt
          if (!text && imageKey) {
            text = '请分析这张图片';
          }

          logger.info({ userId, chatId, chatType, text: text.slice(0, 100), imageKey }, 'Received message');
        }

        // Collect extra media: post images (2nd+) and cached group media
        let extraMedia: IncomingMessage['extraMedia'];
        if (postExtraImages.length > 0) {
          extraMedia = postExtraImages.map(media => ({
            messageId,
            ...media,
          }));
          logger.info({ chatId, postExtraImageCount: postExtraImages.length }, 'Attached extra images from post');
        }
        if (chatType === 'group') {
          const cached = getCachedMedia(chatId, userId);
          if (cached.length > 0) {
            const cachedMedia = cached.map(m => ({
              messageId: m.messageId,
              imageKey: m.imageKey,
              fileKey: m.fileKey,
              fileName: m.fileName,
              mimeType: m.mimeType,
              sizeBytes: m.sizeBytes,
            }));
            extraMedia = extraMedia ? [...extraMedia, ...cachedMedia] : cachedMedia;
            clearCachedMedia(chatId, userId);
            logger.info({ chatId, userId, mediaCount: cached.length }, 'Attached cached media to @mention message');
          }
        }

        const syntheticProbe = classifySyntheticProbe({
          unionId: sender?.sender_id?.union_id,
          chatId,
          text,
          fileName,
        }, syntheticAllowlist);
        if (syntheticProbe) text = stripSyntheticControlMarker(text);
        if (syntheticProbe && probeReceiptStore) {
          try {
            probeReceiptStore.record(syntheticProbe, {
              stage: 'feishu_received',
              at: new Date().toISOString(),
              botName: config.name,
              messageId,
            });
          } catch {
            // Reliability observation must never control message delivery.
          }
        }
        const normalized: IncomingMessage = {
          messageId, chatId, chatType, userId, text, imageKey, fileKey, fileName,
          mimeType, sizeBytes, extraMedia,
          ...(syntheticProbe ? { syntheticProbe } : {}),
        };
        if (flywheel) {
          const record = buildFlywheelMessageRecord(event, normalized, config.name);
          try { flywheel.recordMessageReceived(record); } catch { /* Flywheel never controls message delivery. */ }
          try { flywheel.recordEvidence(buildFlywheelRawEventRecord(event, record)); } catch { /* same */ }
          normalized.turnId = record.turnId;
          normalized.flywheelSender = record.sender;
          normalized.flywheelConversation = record.conversation;
        }
        onMessage(normalized);
      } catch (err) {
        logger.error({ err }, 'Error handling message event');
      }
    },
  });

  return dispatcher;
}

export function buildFlywheelRawEventRecord(raw: unknown, message: RecordEventInput): RecordEventInput {
  return {
    ...message,
    runId: null,
    payload: { kind: 'raw_event', raw },
  };
}

export function buildFlywheelMessageRecord(
  event: { sender?: { sender_id?: { union_id?: string; open_id?: string } }; message?: { parent_id?: string; root_id?: string; content?: string } },
  message: IncomingMessage,
  botId: string,
): RecordEventInput {
  const attachments: Array<Record<string, unknown>> = [];
  let rawContent: Record<string, unknown> = {};
  try {
    rawContent = event.message?.content ? JSON.parse(event.message.content) as Record<string, unknown> : {};
  } catch {
    // The normal message parser already handles malformed content.
  }
  if (message.imageKey) attachments.push({
    kind: 'image', platform_ref: message.imageKey,
    mime_type: message.mimeType ?? rawContent.mime_type,
    size_bytes: message.sizeBytes ?? rawContent.file_size ?? rawContent.size,
  });
  if (message.fileKey) attachments.push({
    kind: 'file',
    name: message.fileName,
    platform_ref: message.fileKey,
    mime_type: message.mimeType ?? rawContent.mime_type,
    size_bytes: message.sizeBytes ?? rawContent.file_size ?? rawContent.size,
  });
  for (const media of message.extraMedia ?? []) {
    if (media.imageKey) attachments.push({
      kind: 'image', platform_ref: media.imageKey,
      mime_type: media.mimeType, size_bytes: media.sizeBytes,
    });
    if (media.fileKey) attachments.push({
      kind: 'file', name: media.fileName, platform_ref: media.fileKey,
      mime_type: media.mimeType, size_bytes: media.sizeBytes,
    });
  }
  const senderId = event.sender?.sender_id;
  return {
    botId,
    turnId: randomUUID(),
    runId: null,
    isSynthetic: message.syntheticProbe?.isSynthetic ?? false,
    probeId: message.syntheticProbe?.probeId,
    sender: { provider: 'feishu', union_id: senderId?.union_id, open_id: senderId?.open_id ?? message.userId },
    conversation: {
      platform: 'feishu',
      platform_id: message.chatId,
      type: message.chatType === 'group' ? 'group' : 'direct',
    },
    payload: {
      platform_message_id: message.messageId,
      reply_to_platform_message_id: event.message?.parent_id ?? event.message?.root_id,
      content: message.text,
      attachments,
    },
  };
}

/** Parse image/file message content, returning media fields or undefined on failure. */
function parseMediaMessage(
  message: any, msgType: string, logger: Logger,
): { imageKey?: string; fileKey?: string; fileName?: string; mimeType?: string; sizeBytes?: number } | undefined {
  try {
    const content = JSON.parse(message.content);
    if (msgType === 'image') {
      const imageKey = content.image_key;
      return imageKey ? {
        imageKey,
        mimeType: content.mime_type,
        sizeBytes: numericMetadata(content.file_size ?? content.size),
      } : undefined;
    }
    if (msgType === 'file') {
      const fileKey = content.file_key;
      const fileName = content.file_name;
      return (fileKey && fileName) ? {
        fileKey, fileName,
        mimeType: content.mime_type,
        sizeBytes: numericMetadata(content.file_size ?? content.size),
      } : undefined;
    }
  } catch {
    logger.warn({ msgType }, 'Failed to parse media message for caching');
  }
  return undefined;
}

/**
 * Extract all image_keys from a Feishu post (rich text) message.
 * Looks for { tag: "img", image_key: "..." } elements in the post content.
 */
function extractImagesFromPost(
  content: Record<string, unknown>,
): Array<{ imageKey: string; mimeType?: string; sizeBytes?: number }> {
  const bodies: Array<Record<string, unknown>> = [];

  if (Array.isArray(content.content)) {
    bodies.push(content);
  } else {
    for (const locale of Object.values(content)) {
      if (locale && typeof locale === 'object' && !Array.isArray(locale)) {
        const loc = locale as Record<string, unknown>;
        if (Array.isArray(loc.content)) {
          bodies.push(loc);
        }
      }
    }
  }

  const images: Array<{ imageKey: string; mimeType?: string; sizeBytes?: number }> = [];
  for (const body of bodies) {
    const paragraphs = body.content as unknown[][];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      for (const element of paragraph) {
        if (!element || typeof element !== 'object') continue;
        const el = element as Record<string, unknown>;
        if (el.tag === 'img' && typeof el.image_key === 'string') {
          images.push({
            imageKey: el.image_key,
            mimeType: typeof el.mime_type === 'string' ? el.mime_type : undefined,
            sizeBytes: numericMetadata(el.file_size ?? el.size),
          });
        }
      }
    }
  }

  return images;
}

function numericMetadata(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/**
 * Extract plain text from Feishu post (rich text) message content.
 * Handles two formats:
 *   With locale wrapper: { "zh_cn": { "title": "...", "content": [[{tag, text}, ...], ...] } }
 *   Without locale wrapper: { "title": "...", "content": [[{tag, text}, ...], ...] }
 */
function extractTextFromPost(content: Record<string, unknown>): string {
  // Try to find the post body — either the content itself or nested under a locale key
  const bodies: Array<Record<string, unknown>> = [];

  if (Array.isArray(content.content)) {
    // Direct format (no locale wrapper)
    bodies.push(content);
  } else {
    // Locale-wrapped format: values are { title, content }
    for (const locale of Object.values(content)) {
      if (locale && typeof locale === 'object' && !Array.isArray(locale)) {
        const loc = locale as Record<string, unknown>;
        if (Array.isArray(loc.content)) {
          bodies.push(loc);
        }
      }
    }
  }

  for (const body of bodies) {
    const parts: string[] = [];

    if (body.title && typeof body.title === 'string') {
      parts.push(body.title);
    }

    const paragraphs = body.content as unknown[][];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      const line: string[] = [];
      for (const element of paragraph) {
        if (!element || typeof element !== 'object') continue;
        const el = element as Record<string, unknown>;
        if ((el.tag === 'text' || el.tag === 'a') && typeof el.text === 'string') {
          line.push(el.text);
        }
      }
      if (line.length > 0) {
        parts.push(line.join(''));
      }
    }

    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  return '';
}
