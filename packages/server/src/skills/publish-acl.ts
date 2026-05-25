import type { Credential } from '../auth/credentials.js';
import { canPublishSkill as credCanPublish } from '../auth/credentials.js';

export function canPublishSkill(cred: Credential): boolean {
  return credCanPublish(cred);
}

export function canUnpublishSkill(cred: Credential): boolean {
  return cred.role === 'admin';
}

/**
 * Members see only `published` + `shared`. Admins see everything (return
 * undefined to skip the visibility filter).
 *
 * NOTE: this filter alone is NOT enough — it never lets a member see their
 * own `private` skill. Callers must compose with `isVisibleToCred` below so
 * the owner's other-machine cred sees their own private skills.
 */
export function visibilityFilter(cred: Credential): ('published' | 'shared' | 'private')[] | undefined {
  if (cred.role === 'admin') return undefined;
  return ['published', 'shared'];
}

/**
 * User-level owner-bypass for skill visibility. A member sees a skill iff:
 *   - admin, OR
 *   - skill is `published` / `shared`, OR
 *   - skill's `ownerName` matches the credential's `ownerName` (user-level)
 *
 * Empty `cred.ownerName` or missing `skill.ownerName` skip the bypass —
 * legacy rows can't accidentally grant access.
 */
export function isVisibleToCred(
  skill: { visibility: 'private' | 'published' | 'shared'; ownerName?: string },
  cred: Credential,
): boolean {
  if (cred.role === 'admin') return true;
  if (skill.visibility !== 'private') return true;
  if (!cred.ownerName || !skill.ownerName) return false;
  return skill.ownerName === cred.ownerName;
}

export function filterSkillsForCred<T extends { visibility: 'private' | 'published' | 'shared'; ownerName?: string }>(
  skills: T[],
  cred: Credential,
): T[] {
  if (cred.role === 'admin') return skills;
  return skills.filter((s) => isVisibleToCred(s, cred));
}
