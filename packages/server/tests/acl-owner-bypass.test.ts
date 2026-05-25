import { describe, it, expect } from 'vitest';
import { canRead, canWrite, type Credential } from '../src/auth/credentials.js';

function makeCred(overrides: Partial<Credential> = {}): Credential {
  return {
    id: 'cred-id',
    tokenHash: 'hash',
    botName: 'cli-bot',
    ownerName: 'alice',
    role: 'member',
    // Note: NO /users/alice — owner-bypass is what should grant access.
    writableNamespaces: ['/users/cli-bot'],
    readableNamespaces: ['/shared', '/users/cli-bot'],
    publishSkill: false,
    createdAt: 0,
    revokedAt: null,
    lastUsedAt: null,
    notes: '',
    ...overrides,
  };
}

describe('owner-bypass for canRead / canWrite', () => {
  it('member can read /users/<ownerName>/foo even when readableNamespaces lacks the prefix', () => {
    const cred = makeCred();
    expect(canRead(cred, '/users/alice/notes/2026.md')).toBe(true);
  });

  it('member can write /users/<ownerName>/foo even when writableNamespaces lacks the prefix', () => {
    const cred = makeCred();
    expect(canWrite(cred, '/users/alice/notes/2026.md')).toBe(true);
  });

  it('member CANNOT read another user\'s /users/<otherOwner>/foo', () => {
    const cred = makeCred();
    expect(canRead(cred, '/users/bob/notes/2026.md')).toBe(false);
  });

  it('member CANNOT write another user\'s /users/<otherOwner>/foo', () => {
    const cred = makeCred();
    expect(canWrite(cred, '/users/bob/notes/2026.md')).toBe(false);
  });

  it('empty ownerName disables the owner-bypass (legacy creds stay locked down)', () => {
    const cred = makeCred({ ownerName: '' });
    // /users//foo could otherwise leak through naïve prefix logic — the
    // empty-string short-circuit prevents that.
    expect(canRead(cred, '/users//foo')).toBe(false);
    expect(canWrite(cred, '/users//foo')).toBe(false);
  });

  it('admin short-circuit still wins over owner-bypass', () => {
    const admin = makeCred({ role: 'admin', ownerName: '' });
    expect(canRead(admin, '/users/anyone/foo')).toBe(true);
    expect(canWrite(admin, '/users/anyone/foo')).toBe(true);
  });

  it('owner-bypass matches the ownerName segment exactly (no prefix-leak)', () => {
    const cred = makeCred({ ownerName: 'alice' });
    // /users/alicia must NOT match /users/alice/...
    expect(canRead(cred, '/users/alicia/foo')).toBe(false);
    expect(canWrite(cred, '/users/alicia/foo')).toBe(false);
  });

  it('owner can read/write the bare /users/<ownerName> path (no trailing segment)', () => {
    const cred = makeCred();
    expect(canRead(cred, '/users/alice')).toBe(true);
    expect(canWrite(cred, '/users/alice')).toBe(true);
  });
});
