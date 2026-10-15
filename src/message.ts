// Message renderer: a pure function from a notification's parts to the
// Telegram HTML text. It owns the template, duration formatting, cutting,
// and escaping. Later tickets add the error and dialog shapes beside this one.
export interface CompletedNotificationParts {
  durationMs: number;
  projectName: string;
  sessionName: string | undefined;
  sessionTag: string;
  // Raw reply text; cutting and escaping happen here, never by the caller.
  excerpt: string | undefined;
}

const MAX_EXCERPT_CHARS = 800;

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

export function renderCompletedNotification(parts: CompletedNotificationParts): string {
  const headline = `✅ <b>Completed</b> · ${formatDuration(parts.durationMs)} · #s${parts.sessionTag}`;
  const byline =
    parts.sessionName === undefined
      ? escapeHtml(parts.projectName)
      : `${escapeHtml(parts.projectName)} · ${escapeHtml(parts.sessionName)}`;
  if (parts.excerpt === undefined) {
    return `${headline}\n${byline}`;
  }
  return `${headline}\n${byline}\n\n<blockquote expandable>${cutExcerpt(parts.excerpt)}</blockquote>`;
}
