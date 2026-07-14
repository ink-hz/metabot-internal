import type { SyntheticProbeContext } from './probe-types.js';

const PROBE_ID = '[0-9A-HJKMNP-TV-Z]{26}';
const TEXT_MARKER = new RegExp(
  `^\\[metabot-probe id=(${PROBE_ID}) attempt=(${PROBE_ID})\\](?:\\s|$)`,
);
const FILE_MARKER = new RegExp(
  `^metabot-probe-(${PROBE_ID})-(${PROBE_ID})\\.pdf$`,
);

export interface SyntheticAllowlist {
  unionIds: ReadonlySet<string>;
  chatIds: ReadonlySet<string>;
}

export interface SyntheticProbeCandidate {
  unionId?: string;
  chatId: string;
  text: string;
  fileName?: string;
}

function parseList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

export function loadSyntheticAllowlist(
  env: NodeJS.ProcessEnv = process.env,
): SyntheticAllowlist {
  return {
    unionIds: parseList(env.METABOT_SYNTHETIC_UNION_IDS),
    chatIds: parseList(env.METABOT_SYNTHETIC_CHAT_IDS),
  };
}

export function classifySyntheticProbe(
  input: SyntheticProbeCandidate,
  allowlist: SyntheticAllowlist,
): SyntheticProbeContext | undefined {
  if (
    !input.unionId
    || !allowlist.unionIds.has(input.unionId)
    || !allowlist.chatIds.has(input.chatId)
  ) {
    return undefined;
  }

  const match = TEXT_MARKER.exec(input.text)
    ?? (input.fileName ? FILE_MARKER.exec(input.fileName) : null);
  if (!match) return undefined;
  return {
    isSynthetic: true,
    probeId: match[1],
    attemptId: match[2],
  };
}

export function stripSyntheticControlMarker(text: string): string {
  return text.replace(TEXT_MARKER, '').trimStart();
}
