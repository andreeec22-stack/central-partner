import type { Role } from '@prisma/client';
import type { Tx } from '../../lib/prisma';

// @mentions. Users have no separate username: a user's handle is the local
// part of their email (ana.gomez@empresa.com → @ana.gomez). When two people who
// can see the task share a local part, the full email is their handle instead
// (@ana@empresa.com). Only people who can see the task can be mentioned, so a
// mention never leaks a task to someone outside its department scope.

export const MAX_MENTIONS_PER_COMMENT = 20;

// "@" not glued to a word or email; the handle ends on a letter/digit so
// "@ana." or "@ana," at the end of a sentence still resolves to @ana.
const MENTION = /(?<![\w.@])@([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:@[a-z0-9-]+(?:\.[a-z0-9-]+)+)?)/gi;

export function extractMentions(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(MENTION)) {
    found.add(match[1]!.toLowerCase());
    if (found.size >= MAX_MENTIONS_PER_COMMENT) break;
  }
  return [...found];
}

export interface MentionCandidate {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  departmentId: string | null;
}

export interface Mentionable extends Omit<MentionCandidate, 'email'> {
  handle: string;
}

const localPart = (email: string) => email.toLowerCase().split('@')[0]!;

export function assignHandles(users: MentionCandidate[]): Mentionable[] {
  const counts = new Map<string, number>();
  for (const u of users) counts.set(localPart(u.email), (counts.get(localPart(u.email)) ?? 0) + 1);
  return users.map(({ email, ...u }) => ({
    ...u,
    handle: counts.get(localPart(email))! > 1 ? email.toLowerCase() : localPart(email),
  }));
}

export function resolveMentions(handles: string[], people: Mentionable[]): string[] {
  const byHandle = new Map(people.map((p) => [p.handle, p.id]));
  return [...new Set(handles.map((h) => byHandle.get(h)).filter((id): id is string => !!id))];
}

// Everyone who can see a task in `departmentId`: ADMINs, its members, and the
// JEFE_AREAs granted visibility of it. VIEWERs can be mentioned too (they read).
export async function mentionableUsers(db: Tx, workspaceId: string, departmentId: string): Promise<Mentionable[]> {
  const grants = await db.departmentVisibility.findMany({
    where: { workspaceId, visibleDepartmentIds: { has: departmentId } },
    select: { jefeAreaId: true },
  });
  const users = await db.user.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      OR: [
        { role: 'ADMIN' },
        { departmentId },
        ...(grants.length ? [{ role: 'JEFE_AREA' as const, id: { in: grants.map((g) => g.jefeAreaId) } }] : []),
      ],
    },
    select: { id: true, email: true, displayName: true, role: true, departmentId: true },
    orderBy: { displayName: 'asc' },
  });
  return assignHandles(users);
}
