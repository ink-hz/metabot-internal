import { createHash } from 'node:crypto';
import { parse, stringify } from 'lossless-json';

const ATTACHMENT_TEXT = 'The requested image is attached as a sibling content block.';
const SUPPORTED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const IMAGE_KEYS = new Set(['type', 'source', 'cache_control']);
const SOURCE_KEYS = new Set(['type', 'media_type', 'data']);

type JsonObject = Record<string, unknown>;

export interface ImageBlock extends JsonObject {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export type PromotionResult =
  | { kind: 'passthrough'; body: Buffer }
  | { kind: 'transformed'; body: Buffer; promotedCount: number };

export class InvalidAnthropicRequestError extends Error {
  constructor(message = 'Anthropic request contains malformed JSON') {
    super(message);
    this.name = 'InvalidAnthropicRequestError';
  }
}

interface Inspection {
  promotable: boolean;
  ambiguous: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonObject, allowedKeys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isExactSupportedImage(value: unknown): value is ImageBlock {
  if (!isObject(value) || value.type !== 'image' || !hasOnlyKeys(value, IMAGE_KEYS)) return false;
  const source = value.source;
  return (
    isObject(source) &&
    hasOnlyKeys(source, SOURCE_KEYS) &&
    source.type === 'base64' &&
    typeof source.media_type === 'string' &&
    SUPPORTED_MEDIA_TYPES.has(source.media_type) &&
    typeof source.data === 'string'
  );
}

function inspectRequest(value: unknown): Inspection {
  if (!isObject(value) || !Array.isArray(value.messages)) {
    return { promotable: false, ambiguous: false };
  }

  let promotable = false;
  let ambiguous = false;

  for (const message of value.messages) {
    if (!isObject(message) || message.role !== 'user') continue;
    if (!Array.isArray(message.content)) {
      ambiguous = true;
      continue;
    }

    for (const block of message.content) {
      if (!isObject(block)) continue;

      if (block.type === 'image' && !isExactSupportedImage(block)) {
        ambiguous = true;
      }

      if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue;
      for (const nestedBlock of block.content) {
        if (!isObject(nestedBlock) || nestedBlock.type !== 'image') continue;
        if (isExactSupportedImage(nestedBlock)) promotable = true;
        else ambiguous = true;
      }
    }
  }

  return { promotable, ambiguous };
}

const imageKey = (block: ImageBlock): string =>
  `${block.source.media_type}:${createHash('sha256').update(block.source.data).digest('hex')}`;

function transformRequest(value: JsonObject): number {
  const messages = value.messages as unknown[];
  let promotedCount = 0;

  for (const messageValue of messages) {
    if (!isObject(messageValue) || messageValue.role !== 'user' || !Array.isArray(messageValue.content)) continue;

    const content = messageValue.content;
    const messageImageKeys = new Set<string>();
    for (const block of content) {
      if (isExactSupportedImage(block)) messageImageKeys.add(imageKey(block));
    }

    const rewrittenContent: unknown[] = [];
    for (const blockValue of content) {
      if (!isObject(blockValue) || blockValue.type !== 'tool_result' || !Array.isArray(blockValue.content)) {
        rewrittenContent.push(blockValue);
        continue;
      }

      const nestedContent: unknown[] = [];
      const siblingImages: ImageBlock[] = [];
      let removedFromToolResult = 0;
      for (const nestedBlock of blockValue.content) {
        if (!isExactSupportedImage(nestedBlock)) {
          nestedContent.push(nestedBlock);
          continue;
        }

        promotedCount += 1;
        removedFromToolResult += 1;
        const key = imageKey(nestedBlock);
        if (!messageImageKeys.has(key)) {
          messageImageKeys.add(key);
          siblingImages.push(nestedBlock);
        }
      }

      if (nestedContent.length === 0 && removedFromToolResult > 0) {
        nestedContent.push({ type: 'text', text: ATTACHMENT_TEXT });
      }
      blockValue.content = nestedContent;
      rewrittenContent.push(blockValue, ...siblingImages);
    }
    messageValue.content = rewrittenContent;
  }

  return promotedCount;
}

export function promoteToolResultImages(raw: Buffer): PromotionResult {
  const text = raw.toString('utf8');
  let inspectedValue: unknown;
  try {
    inspectedValue = JSON.parse(text) as unknown;
  } catch {
    throw new InvalidAnthropicRequestError();
  }

  const inspection = inspectRequest(inspectedValue);
  if (!inspection.promotable || inspection.ambiguous) {
    return { kind: 'passthrough', body: raw };
  }

  const losslessValue = parse(text);
  if (!isObject(losslessValue)) {
    return { kind: 'passthrough', body: raw };
  }

  const promotedCount = transformRequest(losslessValue);
  const transformedText = stringify(losslessValue);
  if (transformedText === undefined) {
    throw new Error('Unable to serialize transformed Anthropic request');
  }

  return {
    kind: 'transformed',
    body: Buffer.from(transformedText),
    promotedCount,
  };
}
