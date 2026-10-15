// Message renderer: one pure function from a notification's parts to the
// Telegram HTML text. It owns the template, duration formatting, cutting,
// and escaping for every status.
export type NotificationParts =
  | {
      status: 'completed';
      durationMs: number;
      projectName: string;
      sessionName: string | undefined;
      sessionTag: string;
      detail?: never;
      excerpt: string | undefined;
    }
  | {
      status: 'error';
      durationMs: number;
      projectName: string;
      sessionName: string | undefined;
      sessionTag: string;
      // Raw error message; collapsing, cutting, and escaping happen here.
      // Undefined or empty (after collapsing) omits the detail line.
      detail: string | undefined;
      excerpt: string | undefined;
    }
  | {
      status: 'dialog';
      durationMs?: never;
      projectName: string;
      sessionName: string | undefined;
      sessionTag: string;
      // Raw dialog title; omitted when the dialog has none. Titles are
      // short, so it is escaped but never cut.
      detail: string | undefined;
      excerpt: string | undefined;
    };

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
  if (parts.status === 'completed' || parts.detail === undefined) {
    return undefined;
  }
  if (parts.status === 'dialog') {
    return `<b>${escapeHtml(parts.detail)}</b>`;
  }
  const detail = cutDetail(parts.detail);
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
  if (parts.excerpt !== undefined) {
    body.push(`<blockquote expandable>${cutExcerpt(parts.excerpt)}</blockquote>`);
  }
  if (body.length === 0) {
    return `${headline}\n${byline}`;
  }
  return `${headline}\n${byline}\n\n${body.join('\n')}`;
}
