import { describe, it, expect, afterEach } from 'vitest';
import * as zlib from 'node:zlib';
import { makeKit, type TestKit } from './helpers.js';
import {
  canPublishSkill, visibilityFilter, filterSkillsForCred, isVisibleToCred,
} from '../src/skills/publish-acl.js';
import type { Credential } from '../src/auth/credentials.js';

let kit: TestKit | undefined;

afterEach(() => {
  kit?.cleanup();
  kit = undefined;
});

function issue(kit: TestKit, name: string, role: 'admin' | 'member', publishSkill?: boolean): Credential {
  const { credential } = kit.credentials.issue({
    botName: name, ownerName: name, role,
    publishSkill,
  });
  return kit.credentials.findById(credential.id)!;
}

function issueWithOwner(
  kit: TestKit, botName: string, ownerName: string, role: 'admin' | 'member', publishSkill?: boolean,
): Credential {
  const { credential } = kit.credentials.issue({
    botName, ownerName, role, publishSkill,
  });
  return kit.credentials.findById(credential.id)!;
}

const SKILL_MD = `---
name: my-cool-skill
description: A test skill
tags: a, b
---

# My cool skill

Body content here.
`;

describe('SkillStore + publish-acl', () => {
  it('publish + get + list', () => {
    kit = makeKit('skill-basic');
    const admin = issue(kit, 'admin', 'admin');
    kit.skills.publish({
      name: 'my-cool-skill',
      skillMd: SKILL_MD,
      author: admin.botName,
      ownerCredentialId: admin.id,
      ownerBotName: admin.botName,
      visibility: 'published',
    });
    const got = kit.skills.get('my-cool-skill')!;
    expect(got.name).toBe('my-cool-skill');
    expect(got.description).toBe('A test skill');
    expect(got.tags.sort()).toEqual(['a', 'b']);
    expect(got.version).toBe(1);

    const list = kit.skills.list();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe('my-cool-skill');
  });

  it('republish increments version', () => {
    kit = makeKit('skill-version');
    const admin = issue(kit, 'admin', 'admin');
    kit.skills.publish({ name: 'x', skillMd: SKILL_MD, ownerCredentialId: admin.id });
    kit.skills.publish({ name: 'x', skillMd: SKILL_MD + '\nv2', ownerCredentialId: admin.id });
    expect(kit.skills.get('x')!.version).toBe(2);
  });

  it('search returns matched + scoped to visibility', () => {
    kit = makeKit('skill-search');
    const admin = issue(kit, 'admin', 'admin');
    kit.skills.publish({ name: 'pub', skillMd: SKILL_MD, visibility: 'published', ownerCredentialId: admin.id });
    kit.skills.publish({ name: 'priv', skillMd: SKILL_MD, visibility: 'private', ownerCredentialId: admin.id });

    const allHits = kit.skills.search('cool');
    expect(allHits.length).toBe(2);

    const publicOnly = kit.skills.search('cool', { visibility: ['published', 'shared'] });
    expect(publicOnly.length).toBe(1);
    expect(publicOnly[0].name).toBe('pub');
  });

  it('canPublishSkill: admin yes, member only if flag set', () => {
    kit = makeKit('skill-publish-acl');
    const admin = issue(kit, 'admin', 'admin');
    const m1 = issue(kit, 'm1', 'member', false);
    const m2 = issue(kit, 'm2', 'member', true);
    expect(canPublishSkill(admin)).toBe(true);
    expect(canPublishSkill(m1)).toBe(false);
    expect(canPublishSkill(m2)).toBe(true);
  });

  it('visibilityFilter: admin sees all (undefined), member sees published+shared', () => {
    kit = makeKit('skill-vis');
    const admin = issue(kit, 'admin', 'admin');
    const m = issue(kit, 'm', 'member');
    expect(visibilityFilter(admin)).toBeUndefined();
    expect(visibilityFilter(m)).toEqual(['published', 'shared']);
  });

  it('isVisibleToCred: owner sees own private skill (same ownerName, different botName)', () => {
    kit = makeKit('skill-owner-bypass-visible');
    const aliceM1 = issueWithOwner(kit, 'alice-machine-1', 'alice', 'member', true);
    kit.skills.publish({
      name: 'alice-private',
      skillMd: SKILL_MD,
      visibility: 'private',
      author: aliceM1.botName,
      ownerCredentialId: aliceM1.id,
      ownerBotName: aliceM1.botName,
      ownerName: aliceM1.ownerName,
    });
    const aliceM2 = issueWithOwner(kit, 'alice-machine-2', 'alice', 'member', true);
    const rec = kit.skills.get('alice-private')!;
    expect(isVisibleToCred(rec, aliceM2)).toBe(true);
    // And the bulk filter agrees.
    expect(filterSkillsForCred([rec], aliceM2).length).toBe(1);
  });

  it('isVisibleToCred: non-owner does NOT see another user\'s private skill', () => {
    kit = makeKit('skill-owner-bypass-hidden');
    const alice = issueWithOwner(kit, 'alice-bot', 'alice', 'member', true);
    kit.skills.publish({
      name: 'alice-private',
      skillMd: SKILL_MD,
      visibility: 'private',
      author: alice.botName,
      ownerCredentialId: alice.id,
      ownerBotName: alice.botName,
      ownerName: alice.ownerName,
    });
    const bob = issueWithOwner(kit, 'bob-bot', 'bob', 'member', true);
    const rec = kit.skills.get('alice-private')!;
    expect(isVisibleToCred(rec, bob)).toBe(false);
    expect(filterSkillsForCred([rec], bob).length).toBe(0);
  });

  it('isVisibleToCred: admin always sees everything; published/shared always visible', () => {
    kit = makeKit('skill-owner-bypass-admin');
    const admin = issue(kit, 'admin', 'admin');
    const member = issueWithOwner(kit, 'm-bot', 'm-owner', 'member', true);
    kit.skills.publish({
      name: 'priv', skillMd: SKILL_MD, visibility: 'private',
      ownerCredentialId: admin.id, ownerName: admin.ownerName,
    });
    kit.skills.publish({
      name: 'pub', skillMd: SKILL_MD, visibility: 'published',
      ownerCredentialId: admin.id, ownerName: admin.ownerName,
    });
    const priv = kit.skills.get('priv')!;
    const pub = kit.skills.get('pub')!;
    expect(isVisibleToCred(priv, admin)).toBe(true);
    expect(isVisibleToCred(pub, member)).toBe(true);
    // Member can NOT see the admin's private skill (different ownerName).
    expect(isVisibleToCred(priv, member)).toBe(false);
  });

  it('isVisibleToCred: empty ownerName on the skill never grants access to a member', () => {
    // Legacy rows (pre-2026-05-25) have NULL owner_name. They must NOT
    // accidentally pass the bypass for an empty-ownerName cred — otherwise
    // any unaligned legacy state would grant cross-user access.
    kit = makeKit('skill-owner-bypass-legacy');
    const member = issueWithOwner(kit, 'm-bot', '', 'member', true);
    const legacyPrivate = {
      visibility: 'private' as const,
      ownerName: undefined,
    };
    expect(isVisibleToCred(legacyPrivate, member)).toBe(false);
  });

  it('remove deletes by name', () => {
    kit = makeKit('skill-remove');
    const admin = issue(kit, 'admin', 'admin');
    kit.skills.publish({ name: 'to-remove', skillMd: SKILL_MD, ownerCredentialId: admin.id });
    expect(kit.skills.remove('to-remove')).toBe(true);
    expect(kit.skills.remove('to-remove')).toBe(false);
    expect(kit.skills.get('to-remove')).toBeUndefined();
  });
});
