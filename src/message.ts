// Message renderer: one pure function from a notification's parts to the
// Telegram HTML text. It owns selecting the reply text and error message
// from the run's messages, then the template, duration formatting, cutting,
// and escaping for every status: select → collapse → cut → escape happens
// here, in one place. Callers pass the run's messages (plus status,
// duration, session identity, and the dialog title), never pre-selected
// text.
// Identity of the session a notification belongs to: the project
// containing the session, its display name when set, and the hashtag that
// tells apart sessions in the same project.
import type { RunMessage } from './run.ts';

export interface SessionIdentity {
  projectName: string;
  sessionName: string | undefined;
  sessionTag: string;
}

export type NotificationParts =
  | (SessionIdentity & {
      status: 'completed';
      durationMs: number;
      messages: RunMessage[];
    })
  | (SessionIdentity & {
      status: 'error';
      durationMs: number;
      // The run's messages: the detail is the run's last message's own
      // error, the excerpt its last message with reply text. Collapsing,
      // cutting, and escaping happen here.
      messages: RunMessage[];
    })
  | (SessionIdentity & {
      status: 'dialog';
      // Raw dialog title; omitted when the dialog has none. Titles are
      // short, so it is escaped but never cut.
      title: string | undefined;
      // The run's messages so far, or undefined when there is no run
      // record; then there is no excerpt either.
      messages: RunMessage[] | undefined;
    });;

const MAX_EXCERPT_CHARS = 800;
const MAX_DETAIL_CHARS = 300;

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${String(totalMinutes % 60).padStart(2, '0')}m`;
}

function escapeHtml(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  if (typeof block !== 'object' || block === null) {
    return false;
  }
  const record = block as { type?: unknown; text?: unknown };
  return record.type === 'text' && typeof record.text === 'string';
}

// The run's last assistant message that has reply text, falling back within
// the run and never reaching an earlier one. Thinking blocks are never text;
// tool calls carry no text of their own.
function latestReplyText(messages: RunMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    const text = message.content.filter(isTextBlock).map((block) => block.text).join('');
    if (text !== '') {
      return text;
    }
  }
  return undefined;
}

// The run's last assistant message's error message, never an earlier
// one's. A failed tool call carries no message of its own, so only the
// run's outcome decides between the completed and error shapes.
function lastErrorMessage(messages: RunMessage[]): string | undefined {
  if (messages.length === 0) {
    return undefined;
  }
  return messages[messages.length - 1].errorMessage;
}

// Keeps the last part of a long excerpt, starting with `…`, for 800
// characters in total. The cut is on the raw text, so an entity is never cut
// in half; a cut that would split a surrogate pair backs off one unit.
function cutExcerpt(raw: string): string {
  if (raw.length <= MAX_EXCERPT_CHARS) {
    return escapeHtml(raw);
  }
  let tail = raw.slice(raw.length - (MAX_EXCERPT_CHARS - 1));
  const first = tail.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) {
    tail = tail.slice(1);
  }
  return escapeHtml(`…${tail}`);
}

// Collapses whitespace to single spaces and keeps the first part of a long
// detail, ending with `…`, for 300 characters in total. The cut is on the
// raw collapsed text, so an entity is never cut in half; a cut that would
// split a surrogate pair backs off one unit. Empty after collapsing omits.
function cutDetail(raw: string): string | undefined {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed === '') {
    return undefined;
  }
  if (collapsed.length <= MAX_DETAIL_CHARS) {
    return escapeHtml(collapsed);
  }
  let head = collapsed.slice(0, MAX_DETAIL_CHARS - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    head = head.slice(0, -1);
  }
  return escapeHtml(`${head}…`);
}

function formatByline(projectName: string, sessionName: string | undefined): string {
  return sessionName === undefined
    ? escapeHtml(projectName)
    : `${escapeHtml(projectName)} · ${escapeHtml(sessionName)}`;
}

function formatHeadline(parts: NotificationParts): string {
  switch (parts.status) {
    case 'completed':
      return `✅ <b>Completed</b> · ${formatDuration(parts.durationMs)} · #s${parts.sessionTag}`;
    case 'error':
      return `❌ <b>Error</b> · ${formatDuration(parts.durationMs)} · #s${parts.sessionTag}`;
    case 'dialog':
      return `❓ <b>Waiting for you</b> · #s${parts.sessionTag}`;
  }
}

function formatDetail(parts: NotificationParts): string | undefined {
  if (parts.status === 'completed') {
    return undefined;
  }
  if (parts.status === 'dialog') {
    return parts.title === undefined ? undefined : `<b>${escapeHtml(parts.title)}</b>`;
  }
  const raw = lastErrorMessage(parts.messages);
  if (raw === undefined) {
    return undefined;
  }
  const detail = cutDetail(raw);
  return detail === undefined ? undefined : `<b>${detail}</b>`;
}

export function renderNotification(parts: NotificationParts): string {
  const headline = formatHeadline(parts);
  const byline = formatByline(parts.projectName, parts.sessionName);
  const body: string[] = [];
  const detail = formatDetail(parts);
  if (detail !== undefined) {
    body.push(detail);
  }
  const excerpt = parts.messages === undefined ? undefined : latestReplyText(parts.messages);
  if (excerpt !== undefined) {
    body.push(`<blockquote expandable>${cutExcerpt(excerpt)}</blockquote>`);
  }
  if (body.length === 0) {
    return `${headline}\n${byline}`;
  }
  return `${headline}\n${byline}\n\n${body.join('\n')}`;
}
