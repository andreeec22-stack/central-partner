import type { MentionRef } from './types';

// Mirrors the API's mention syntax (@local-part of the email, or the full email
// when two people share it), so what the UI highlights is exactly what notifies.
export const MENTION_RE = /(?<![\w.@])@([a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:@[a-z0-9-]+(?:\.[a-z0-9-]+)+)?)/gi;

export type CommentPart = { kind: 'text'; text: string } | { kind: 'mention'; text: string; user: MentionRef };

// Splits a comment into plain text and the mentions that actually resolved.
export function splitMentions(content: string, mentioned: MentionRef[]): CommentPart[] {
  const byHandle = new Map(mentioned.map((m) => [m.handle.toLowerCase(), m]));
  const parts: CommentPart[] = [];
  let last = 0;
  for (const match of content.matchAll(MENTION_RE)) {
    const user = byHandle.get(match[1]!.toLowerCase());
    if (!user) continue;
    if (match.index > last) parts.push({ kind: 'text', text: content.slice(last, match.index) });
    parts.push({ kind: 'mention', text: match[0], user });
    last = match.index + match[0].length;
  }
  if (last < content.length) parts.push({ kind: 'text', text: content.slice(last) });
  return parts;
}

// The "@partial" being typed right before the caret, if any.
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = before.match(/(^|[\s(])@([\w.@-]*)$/);
  if (!match) return null;
  return { start: caret - match[2]!.length - 1, query: match[2]! };
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export function filterMentionables<T extends MentionRef>(people: T[], query: string, limit = 6): T[] {
  const q = fold(query);
  if (!q) return people.slice(0, limit);
  const starts = people.filter((p) => fold(p.handle).startsWith(q) || fold(p.displayName).split(/\s+/).some((w) => w.startsWith(q)));
  const contains = people.filter((p) => !starts.includes(p) && (fold(p.handle).includes(q) || fold(p.displayName).includes(q)));
  return [...starts, ...contains].slice(0, limit);
}
