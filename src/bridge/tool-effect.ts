export type ToolEffect = 'read_only' | 'local_idempotent' | 'external_side_effect';

const EFFECT_ORDER: Readonly<Record<ToolEffect, number>> = Object.freeze({
  read_only: 0,
  local_idempotent: 1,
  external_side_effect: 2,
});

const READ_ONLY_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'ls',
  'websearch',
  'webfetch',
]);

const LOCAL_WRITE_TOOLS = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
]);

const SHELL_CONTROL = /[\n\r;|&><`]|\$\(/;
const SIMPLE_INSPECTION = /^(?:pwd|ls|which|file|stat|wc|head|tail|rg)(?:\s|$)/i;
const COMMAND_LOOKUP = /^command\s+-v(?:\s|$)/i;
const GIT_INSPECTION = /^git\s+(?:status|log|diff|show|rev-parse)(?:\s|$)/i;
const VERSION_PROBE = /^(?:pandoc|node|npm|npx|claude)\s+(?:--version|-v)(?:\s|$)/i;

function isReadOnlyBash(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== 'string') return false;
  const value = command.trim();
  if (!value || SHELL_CONTROL.test(value)) return false;
  return SIMPLE_INSPECTION.test(value)
    || COMMAND_LOOKUP.test(value)
    || GIT_INSPECTION.test(value)
    || VERSION_PROBE.test(value);
}

export function classifyToolEffect(name: string | undefined, input: unknown): ToolEffect {
  const normalized = name?.replace(/[_-]/g, '').toLowerCase() ?? '';
  if (READ_ONLY_TOOLS.has(normalized)) return 'read_only';
  if (normalized === 'bash') return isReadOnlyBash(input)
    ? 'read_only'
    : 'external_side_effect';
  if (LOCAL_WRITE_TOOLS.has(normalized)) return 'local_idempotent';
  return 'external_side_effect';
}

export function strongestToolEffect(left: ToolEffect, right: ToolEffect): ToolEffect {
  return EFFECT_ORDER[left] >= EFFECT_ORDER[right] ? left : right;
}
