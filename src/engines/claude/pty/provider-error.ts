import type { RawJsonlRecord } from './contract.js';

const MAX_PROVIDER_ERROR_CHARS = 500;
const SECRET_VALUE = String.raw`[^\s,;"']+`;

export interface ProviderErrorEnvelope {
  kind: 'api_error';
  status?: number;
  message: string;
}

function sanitizeProviderMessage(value: string): string {
  const redacted = value
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(
      new RegExp(`\\b(x-api-key|api[_-]?key|auth(?:orization)?[_-]?token|access[_-]?token)(\\s*[:=]\\s*)${SECRET_VALUE}`, 'gi'),
      '$1$2[REDACTED]',
    )
    .replace(/\s+/g, ' ')
    .trim();
  return redacted.slice(0, MAX_PROVIDER_ERROR_CHARS);
}

export function extractProviderError(record: RawJsonlRecord): ProviderErrorEnvelope {
  const rawStatus = record.apiErrorStatus;
  const status = typeof rawStatus === 'number' && Number.isFinite(rawStatus)
    ? rawStatus
    : undefined;
  const message = record.message as { content?: unknown } | undefined;
  const text = Array.isArray(message?.content)
    ? message.content
      .filter((block): block is { type: 'text'; text: string } => Boolean(
        block && typeof block === 'object'
          && (block as { type?: unknown }).type === 'text'
          && typeof (block as { text?: unknown }).text === 'string',
      ))
      .map((block) => block.text)
      .join(' ')
    : '';
  const fallback = status === undefined
    ? 'API Error: provider request failed'
    : `API Error: provider request failed (${status})`;

  return {
    kind: 'api_error',
    ...(status === undefined ? {} : { status }),
    message: sanitizeProviderMessage(text) || fallback,
  };
}
