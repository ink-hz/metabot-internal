const SENSITIVE_KEY = /(password|secret|credential|authorization|api[_-]?token|access[_-]?token|refresh[_-]?token|auth[_-]?token|token$)/i;
const SENSITIVE_STRING_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bxoxb-[A-Za-z0-9_-]{8,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/-]+/i,
  /\bAKIA[A-Z0-9]{16}\b/,
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/@]+:[^@\s/]+@/i,
];

export interface Redactor {
  sanitize<T>(value: T): T | null;
  containsSensitive(value: unknown): boolean;
}

export function createRedactor(knownSecrets: string[]): Redactor {
  const secrets = [...new Set(knownSecrets.filter((secret) => secret.length >= 4))]
    .sort((a, b) => b.length - a.length);

  const sanitize = <T>(value: T): T | null => sanitizeValue(value, secrets) as T | null;
  const containsSensitive = (value: unknown): boolean => containsSensitiveValue(value, secrets);
  return { sanitize, containsSensitive };
}

export function collectKnownSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => value && SENSITIVE_KEY.test(key))
    .map(([, value]) => value as string);
}

function sanitizeValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, secrets)).filter((item) => item !== null);
  }
  if (!value || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  if (typeof source.type === 'string' && source.type.toLowerCase() === 'thinking') return null;

  const clean: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (SENSITIVE_KEY.test(key) || key.toLowerCase() === 'thinking') continue;
    const sanitized = sanitizeValue(child, secrets);
    if (sanitized !== null) clean[key] = sanitized;
  }
  return clean;
}

function containsSensitiveValue(value: unknown, secrets: string[]): boolean {
  if (typeof value === 'string') {
    return secrets.some((secret) => value.includes(secret))
      || SENSITIVE_STRING_PATTERNS.some((pattern) => pattern.test(value));
  }
  if (Array.isArray(value)) return value.some((item) => containsSensitiveValue(item, secrets));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([key, child]) => SENSITIVE_KEY.test(key) || containsSensitiveValue(child, secrets));
}

function redactString(value: string, secrets: string[]): string {
  let clean = value;
  for (const secret of secrets) clean = clean.split(secret).join('[REDACTED]');
  return clean
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bxoxb-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@');
}
