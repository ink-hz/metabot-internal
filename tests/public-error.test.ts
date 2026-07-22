import { describe, expect, it } from 'vitest';

import {
  classifyReliabilityError,
  RELIABILITY_ERROR_CLASSES,
  toPublicError,
} from '../src/reliability/public-error.js';

describe('stable public errors', () => {
  it('maps known failures to actionable content without internal details', () => {
    expect(toPublicError('claude_preflight', 'R-01J2Z9K2')).toEqual({
      code: 'CLAUDE_NOT_READY',
      incidentId: 'R-01J2Z9K2',
      message: 'Claude 运行环境暂未就绪，维护者已收到通知。',
    });
  });

  it('has an explicit public mapping for every design error class', () => {
    for (const errorClass of RELIABILITY_ERROR_CLASSES) {
      const result = toPublicError(errorClass, 'R-01J2Z9M7');
      expect(result.code).not.toBe('UNEXPECTED_FAILURE');
      expect(result.incidentId).toBe('R-01J2Z9M7');
    }
  });

  it('uses a correlated, redacted fallback for unknown errors', () => {
    const result = toPublicError('unknown', 'R-01J2Z9M7');
    expect(result).toEqual({
      code: 'UNEXPECTED_FAILURE',
      incidentId: 'R-01J2Z9M7',
      message: '本次处理未能完整完成，维护者已收到通知。',
    });
    expect(result.message).not.toMatch(/path|token|gateway|Ended with/iu);
  });

  it('classifies only recognized failure shapes and never returns raw text', () => {
    expect(classifyReliabilityError('spawn /private/bin/claude ENOENT')).toBe('claude_preflight');
    expect(classifyReliabilityError('No conversation found with session ID abc')).toBe('claude_session');
    expect(classifyReliabilityError("ValidationException: tool type 'web_search_20250305' is not supported")).toBe('gateway_capability_optional');
    expect(classifyReliabilityError('request failed with ECONNRESET')).toBe('gateway_transport');
    expect(classifyReliabilityError('Ended with: error secret=abc')).toBe('unknown');
  });

  it('classifies terminal provider failures with stable public codes', () => {
    expect(classifyReliabilityError('API Error: The operation timed out.')).toBe('timeout');
    expect(toPublicError('timeout', 'R-timeout').code).toBe('TASK_TIMEOUT');

    for (const message of [
      'API Error: Request rejected (429) due to provider capacity',
      'API Error: HTTP 502 Bad Gateway',
      'API Error: upstream returned status 503',
      'API Error: gateway timeout 504',
      'request failed with socket hang up',
    ]) {
      expect(classifyReliabilityError(message)).toBe('gateway_transport');
    }
    expect(toPublicError('gateway_transport', 'R-gateway').code)
      .toBe('MODEL_GATEWAY_UNAVAILABLE');

    expect(classifyReliabilityError('API Error: provider rejected an unfamiliar condition'))
      .toBe('provider_error');
    expect(toPublicError('provider_error', 'R-provider').code).toBe('MODEL_PROVIDER_ERROR');
  });

  it('keeps non-transient provider failures out of the gateway transport class', () => {
    expect(classifyReliabilityError('API Error: 400 malformed request')).toBe('provider_error');
    expect(classifyReliabilityError('API Error: 401 authentication failed')).toBe('provider_error');
    expect(classifyReliabilityError('configured model mismatch')).toBe('model_mismatch');
    expect(classifyReliabilityError('invalid session id')).toBe('claude_session');
  });
});
