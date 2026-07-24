import { describe, it, expect } from 'vitest';
import {
  isCrossVerifyRoute,
  isLoopbackAddress,
  isRuntimeObservationRoute,
} from '../src/api/http-server.js';

describe('runtime observation access', () => {
  it('matches only the exact read-only route', () => {
    expect(isRuntimeObservationRoute('GET', '/api/observability/runtime')).toBe(true);
    expect(isRuntimeObservationRoute('POST', '/api/observability/runtime')).toBe(false);
    expect(isRuntimeObservationRoute('GET', '/api/observability/runtime?full=1')).toBe(false);
  });

  it('accepts socket loopback forms without trusting forwarded addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('isCrossVerifyRoute', () => {
  it('accepts the talk RPC routes', () => {
    expect(isCrossVerifyRoute('POST', '/api/talk')).toBe(true);
    expect(isCrossVerifyRoute('POST', '/api/talk?async=true')).toBe(true);
    expect(isCrossVerifyRoute('POST', '/api/tasks')).toBe(true);
    expect(isCrossVerifyRoute('GET', '/api/talk/abc-123')).toBe(true);
  });

  it('keeps core-chat delivery out of generic cross-verified bearer routes', () => {
    expect(isCrossVerifyRoute('POST', '/api/core-chat/runs')).toBe(false);
    expect(isCrossVerifyRoute('POST', '/api/core-chat/runs?source=core')).toBe(false);
    expect(isCrossVerifyRoute('POST', '/api/core-chat/runs/run-123/cancel')).toBe(false);
    expect(isCrossVerifyRoute('POST', '/api/core-chat/runs/run-123/cancel?retry=1')).toBe(false);
  });

  it('accepts the read-only peer-discovery routes', () => {
    expect(isCrossVerifyRoute('GET', '/api/bots')).toBe(true);
    expect(isCrossVerifyRoute('GET', '/api/bots?foo=1')).toBe(true);
    expect(isCrossVerifyRoute('GET', '/api/skills')).toBe(true);
    expect(isCrossVerifyRoute('GET', '/api/peers')).toBe(true);
  });

  it('rejects write operations on the read-only routes', () => {
    expect(isCrossVerifyRoute('POST', '/api/bots')).toBe(false);
    expect(isCrossVerifyRoute('PUT', '/api/bots/goku')).toBe(false);
    expect(isCrossVerifyRoute('DELETE', '/api/bots/goku')).toBe(false);
    expect(isCrossVerifyRoute('POST', '/api/skills')).toBe(false);
  });

  it('rejects per-name detail routes (only the list endpoint is shared)', () => {
    expect(isCrossVerifyRoute('GET', '/api/bots/goku')).toBe(false);
    expect(isCrossVerifyRoute('GET', '/api/bots/goku/profile')).toBe(false);
  });

  it('rejects unrelated routes', () => {
    expect(isCrossVerifyRoute('GET', '/api/health')).toBe(false);
    expect(isCrossVerifyRoute('GET', '/api/schedule')).toBe(false);
    expect(isCrossVerifyRoute('POST', '/api/schedule')).toBe(false);
    expect(isCrossVerifyRoute('GET', '/api/core-chat/runs')).toBe(false);
    expect(isCrossVerifyRoute('POST', '/api/core-chat/runs/run-123/events')).toBe(false);
  });
});
