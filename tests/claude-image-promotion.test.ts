import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InvalidAnthropicRequestError,
  promoteToolResultImages,
} from '../src/engines/claude/compatibility/image-promotion.js';

const ATTACHMENT_TEXT = 'The requested image is attached as a sibling content block.';
const demo1Data = Buffer.from('demo-image-one').toString('base64');
const demo2Data = Buffer.from('demo-image-two').toString('base64');

type JsonObject = Record<string, unknown>;

function image(data: string, mediaType = 'image/png', extra: JsonObject = {}): JsonObject {
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data },
    ...extra,
  };
}

function requestWith(content: unknown[]): Buffer {
  return Buffer.from(
    JSON.stringify({
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content }],
    }),
  );
}

function bodyJson(body: Buffer): JsonObject {
  return JSON.parse(body.toString('utf8')) as JsonObject;
}

function firstMessageContent(body: Buffer): JsonObject[] {
  const root = bodyJson(body);
  const messages = root.messages as JsonObject[];
  return messages[0].content as JsonObject[];
}

function hashImageData(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

function imageHashesByUserMessage(body: Buffer): string[][] {
  const root = bodyJson(body);
  return (root.messages as JsonObject[])
    .filter((message) => message.role === 'user')
    .map((message) =>
      (message.content as JsonObject[])
        .filter((block) => block.type === 'image')
        .map((block) => hashImageData((block.source as JsonObject).data as string)),
    );
}

describe('Claude nested tool-result image promotion', () => {
  it('promotes the exact supported nested image shape as an immediate sibling', () => {
    const raw = requestWith([
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: [image(demo1Data)],
      },
      { type: 'text', text: 'after' },
    ]);

    const result = promoteToolResultImages(raw);

    expect(result.kind).toBe('transformed');
    if (result.kind !== 'transformed') throw new Error('expected transformed request');
    expect(result.promotedCount).toBe(1);
    expect(firstMessageContent(result.body)).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: [{ type: 'text', text: ATTACHMENT_TEXT }],
      },
      image(demo1Data),
      { type: 'text', text: 'after' },
    ]);
  });

  it('keeps non-image nested content and places images after their owning tool results', () => {
    const first = image(demo1Data, 'image/jpeg');
    const second = image(demo2Data, 'image/webp');
    const raw = requestWith([
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: [{ type: 'text', text: 'first result' }, first],
      },
      { type: 'text', text: 'between' },
      {
        type: 'tool_result',
        tool_use_id: 'tool-2',
        content: [second, { type: 'text', text: 'second result' }],
      },
    ]);

    const result = promoteToolResultImages(raw);

    expect(result.kind).toBe('transformed');
    if (result.kind !== 'transformed') throw new Error('expected transformed request');
    expect(result.promotedCount).toBe(2);
    expect(firstMessageContent(result.body)).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: [{ type: 'text', text: 'first result' }],
      },
      first,
      { type: 'text', text: 'between' },
      {
        type: 'tool_result',
        tool_use_id: 'tool-2',
        content: [{ type: 'text', text: 'second result' }],
      },
      second,
    ]);
  });

  it('leaves nested PDF documents byte-for-byte unchanged', () => {
    const raw = requestWith([
      {
        type: 'tool_result',
        tool_use_id: 'tool-pdf',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: demo1Data },
          },
        ],
      },
    ]);

    const result = promoteToolResultImages(raw);

    expect(result.kind).toBe('passthrough');
    expect(result.body).toBe(raw);
    expect(result.body.equals(raw)).toBe(true);
  });

  it('leaves unsupported nested image media types byte-for-byte unchanged', () => {
    const raw = requestWith([
      {
        type: 'tool_result',
        tool_use_id: 'tool-bmp',
        content: [image(demo1Data, 'image/bmp')],
      },
    ]);

    const result = promoteToolResultImages(raw);

    expect(result.kind).toBe('passthrough');
    expect(result.body).toBe(raw);
    expect(result.body.equals(raw)).toBe(true);
  });

  it('fails safe to original bytes for an image source with unknown fields', () => {
    const raw = Buffer.from(
      JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-ambiguous',
                content: [
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: demo1Data,
                      unrecognized: true,
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const result = promoteToolResultImages(raw);

    expect(result.kind).toBe('passthrough');
    expect(result.body).toBe(raw);
  });

  it('throws the explicit invalid-request error for malformed JSON', () => {
    const raw = Buffer.from('{"messages":[');

    expect(() => promoteToolResultImages(raw)).toThrow(InvalidAnthropicRequestError);
    expect(() => promoteToolResultImages(raw)).toThrow(/malformed JSON/i);
  });

  it('returns the original Buffer for valid non-target input with a large integer', () => {
    const raw = Buffer.from('{ "unknown":900719925474099312345, "messages":[] }');

    const result = promoteToolResultImages(raw);

    expect(result.kind).toBe('passthrough');
    expect(result.body).toBe(raw);
    expect(result.body.equals(raw)).toBe(true);
  });

  it('preserves a large integer exactly when rewriting a target request', () => {
    const raw = Buffer.from(
      `{"unknown":900719925474099312345,"model":"claude-opus-4-8","messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-large","content":[${JSON.stringify(image(demo1Data))}]}]}]}`,
    );

    const result = promoteToolResultImages(raw);

    expect(result.kind).toBe('transformed');
    expect(result.body.toString('utf8')).toContain('"unknown":900719925474099312345');
  });

  it('preserves the complete image block including cache_control', () => {
    const cachedImage = image(demo1Data, 'image/gif', {
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    const raw = requestWith([
      {
        type: 'tool_result',
        tool_use_id: 'tool-cache',
        content: [cachedImage],
      },
    ]);

    const result = promoteToolResultImages(raw);

    expect(result.kind).toBe('transformed');
    expect(firstMessageContent(result.body)[1]).toEqual(cachedImage);
  });

  it('deduplicates only within each historical user message and is idempotent', () => {
    const historyBody = Buffer.from(
      JSON.stringify({
        model: 'claude-opus-4-8',
        messages: [demo1Data, demo2Data, demo1Data].map((data, index) => ({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: `tool-${index + 1}`,
              content: [image(data)],
            },
          ],
        })),
      }),
    );
    const demo1 = hashImageData(demo1Data);
    const demo2 = hashImageData(demo2Data);

    const once = promoteToolResultImages(historyBody);
    const twice = promoteToolResultImages(once.body);

    expect(once.kind).toBe('transformed');
    expect(twice.kind).toBe('passthrough');
    expect(twice.body).toBe(once.body);
    expect(imageHashesByUserMessage(twice.body)).toEqual([[demo1], [demo2], [demo1]]);
  });

  it('does not append a duplicate when the same image is already a sibling', () => {
    const existing = image(demo1Data);
    const raw = requestWith([
      existing,
      {
        type: 'tool_result',
        tool_use_id: 'tool-duplicate',
        content: [image(demo1Data)],
      },
    ]);

    const once = promoteToolResultImages(raw);
    const twice = promoteToolResultImages(once.body);

    expect(once.kind).toBe('transformed');
    expect(firstMessageContent(once.body).filter((block) => block.type === 'image')).toHaveLength(1);
    expect(twice.kind).toBe('passthrough');
    expect(twice.body).toBe(once.body);
  });
});
