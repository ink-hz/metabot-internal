const SENSITIVE_KEY = /(password|token|secret|credential)/i;

export interface Redactor {
  sanitize<T>(value: T): T | null;
}

export function createRedactor(knownSecrets: string[]): Redactor {
  const secrets = [...new Set(knownSecrets.filter((secret) => secret.length >= 4))]
    .sort((a, b) => b.length - a.length);

  const sanitize = <T>(value: T): T | null => sanitizeValue(value, secrets) as T | null;
  return { sanitize };
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
