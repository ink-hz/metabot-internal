import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCapabilityEvidence,
  classifyNativeWebFetch,
  classifyNativeWebSearch,
  writeCapabilityEvidence,
} from '../scripts/probe-opus-gateway-capabilities.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Opus capability probe evidence', () => {
  it('classifies the current Bedrock native WebSearch rejection', () => {
    expect(classifyNativeWebSearch({
      exitCode: 0,
      latencyMs: 100,
      completedRequests: 0,
      httpStatus: 400,
      output: "ValidationException: tool type 'web_search_20250305' is not supported for this model",
    })).toMatchObject({
      status: 'upstream_unsupported',
      httpStatus: 400,
      providerErrorType: 'aws_invoke_error',
      completedRequests: 0,
    });
  });

  it('classifies successful and transport-failed native WebSearch independently', () => {
    expect(classifyNativeWebSearch({
      exitCode: 0, latencyMs: 10, completedRequests: 1, output: 'success',
    }).status).toBe('available');
    expect(classifyNativeWebSearch({
      exitCode: 1, latencyMs: 10, completedRequests: 0, networkError: true, output: 'connect failed',
    }).status).toBe('transport_error');
  });

  it('classifies WebFetch domain verification separately from server-tool support', () => {
    expect(classifyNativeWebFetch({
      exitCode: 0, latencyMs: 10, completedRequests: 0,
      output: 'Unable to verify whether domain example.invalid is safe to access',
    }).status).toBe('domain_verification_failed');
    expect(classifyNativeWebFetch({
      exitCode: 0, latencyMs: 10, completedRequests: 1, output: 'fetched',
    }).status).toBe('available');
  });

  it('builds evidence without prompts, responses, request ids, or credentials', () => {
    const evidence = buildCapabilityEvidence({
      profileId: 'nexcor-opus-4-8-claude-code-2.1.207',
      model: 'claude-opus-4-8',
      claudeCodeVersion: '2.1.207',
      search: {
        exitCode: 0, latencyMs: 20, completedRequests: 0, httpStatus: 400,
        output: 'secret-prompt-marker request id req-secret bearer-token-marker web_search_20250305 not supported',
      },
      fetch: {
        exitCode: 0, latencyMs: 30, completedRequests: 0,
        output: 'Unable to verify whether domain secret-url-marker is safe to access',
      },
    });
    const serialized = JSON.stringify(evidence);

    expect(evidence.nativeWebSearch.status).toBe('upstream_unsupported');
    expect(evidence.nativeWebFetch.status).toBe('domain_verification_failed');
    expect(serialized).not.toContain('secret-prompt-marker');
    expect(serialized).not.toContain('req-secret');
    expect(serialized).not.toContain('bearer-token-marker');
    expect(serialized).not.toContain('secret-url-marker');
  });

  it('writes evidence atomically with mode 0600', () => {
    const home = mkdtempSync(join(tmpdir(), 'metabot-capability-test-'));
    tempDirs.push(home);
    const evidence = buildCapabilityEvidence({
      profileId: 'nexcor-opus-4-8-claude-code-2.1.207',
      model: 'claude-opus-4-8',
      claudeCodeVersion: '2.1.207',
      search: { exitCode: 0, latencyMs: 1, completedRequests: 1, output: '' },
      fetch: { exitCode: 0, latencyMs: 1, completedRequests: 1, output: '' },
    });

    const path = writeCapabilityEvidence(evidence, home);

    expect(path).toBe(join(home, '.metabot', 'capabilities', `${evidence.profileId}.json`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).profileId).toBe(evidence.profileId);
  });
});
