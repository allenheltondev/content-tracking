import type { ChatEntry, ChatRole } from '../api/types';

const VALID_ROLES: ReadonlySet<ChatRole> = new Set(['vendor', 'influencer', 'user', 'assistant']);
const ROLE_PREFIX = /^(vendor|influencer|user|assistant)\s*:\s*(.*)$/i;

export class ChatParseError extends Error {}

// Accepts either a JSON array matching the API's `conversation` shape or
// a plain-text transcript with `role: content` lines. Lines without a
// role prefix get appended to the previous entry, so multi-paragraph
// messages survive intact.
export function parseChatInput(raw: string): ChatEntry[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ChatParseError('Paste a chat transcript or JSON conversation first.');
  }
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    return parseJsonShape(trimmed);
  }
  return parseTranscript(trimmed);
}

function parseJsonShape(text: string): ChatEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ChatParseError(`JSON is malformed: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ChatParseError('JSON must be a non-empty array of { role, content } entries.');
  }
  const out: ChatEntry[] = [];
  for (const [i, item] of parsed.entries()) {
    if (typeof item !== 'object' || item === null) {
      throw new ChatParseError(`Entry ${i} is not an object.`);
    }
    const obj = item as { role?: unknown; content?: unknown };
    if (typeof obj.role !== 'string' || !VALID_ROLES.has(obj.role as ChatRole)) {
      throw new ChatParseError(
        `Entry ${i} has invalid role. Allowed: ${[...VALID_ROLES].join(', ')}.`,
      );
    }
    if (typeof obj.content !== 'string' || obj.content.length === 0) {
      throw new ChatParseError(`Entry ${i} has empty content.`);
    }
    out.push({ role: obj.role as ChatRole, content: obj.content });
  }
  return out;
}

function parseTranscript(text: string): ChatEntry[] {
  const lines = text.split(/\r?\n/);
  const out: ChatEntry[] = [];
  for (const line of lines) {
    const match = line.match(ROLE_PREFIX);
    if (match) {
      const role = match[1].toLowerCase() as ChatRole;
      const content = match[2];
      out.push({ role, content });
    } else if (out.length > 0) {
      out[out.length - 1] = {
        ...out[out.length - 1],
        content: out[out.length - 1].content + (line.length > 0 ? `\n${line}` : ''),
      };
    } else if (line.trim().length > 0) {
      throw new ChatParseError(
        'First non-blank line must start with a role (vendor, influencer, user, or assistant) followed by a colon.',
      );
    }
  }
  const cleaned = out
    .map((e) => ({ role: e.role, content: e.content.trim() }))
    .filter((e) => e.content.length > 0);
  if (cleaned.length === 0) {
    throw new ChatParseError('No usable entries found in the transcript.');
  }
  return cleaned;
}
