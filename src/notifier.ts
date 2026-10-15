// Notification sender: one per session, created at session start. It owns
// the credentials snapshot taken then (never re-read per send, so a change
// mid-session is ignored like any other late configuration), the post to
// the Bot API, the response classification, and the warn-once-until-success
// latch for this session: after `/new` or in another session in the same
// process, an ongoing outage warns once again. A session that started
// without its configuration, or outside `tui`, gets a sender that sends
// nothing. Warning goes through the latest event's context, refreshed on
// every handled event, and goes silent once closed at session shutdown.
// Fire-and-forget: `notify` returns nothing and no failure path throws, so
// a send can never delay, abort, or crash the session. A failed send is
// never retried.
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

// Minimum run age a notification requires, in seconds: a run that stops or
// opens a dialog sooner stays silent, so a quick run the developer watched
// never rings the phone. Zero notifies always. Exported for the run
// tracker's initial threshold; session start overwrites it from the
// environment.
export const DEFAULT_MIN_RUN_SECONDS = 60;

interface SessionCredentials {
  botToken: string;
  chatId: string;
}

interface SessionConfig {
  // Undefined sends nothing: the session started misconfigured or outside
  // `tui`.
  credentials: SessionCredentials | undefined;
  minRunMs: number;
}

// Reads the minimum run duration from the environment in milliseconds: unset
// or blank means the default, and anything else must be a non-negative
// number of seconds. Returns the fallback plus the offending value, so the
// caller can warn about it once at session start.
function minRunDurationMs(): { ms: number; invalid: string | undefined } {
  const raw = process.env.PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS;
  if (raw === undefined || raw.trim() === '') {
    return { ms: DEFAULT_MIN_RUN_SECONDS * 1000, invalid: undefined };
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return { ms: DEFAULT_MIN_RUN_SECONDS * 1000, invalid: raw };
  }
  return { ms: seconds * 1000, invalid: undefined };
}

// Reads the session's configuration once, warning about each problem with
// its exact text: each missing (unset or empty) variable is named, and an
// invalid minimum falls back to the default. Each warning is isolated, so
// a throwing notify still leaves the session fully configured. Sessions
// outside `tui` never warn. The credentials snapshot is what the session's
// sender uses; a variable exported mid-session never changes a running
// session's mind.
export function readSessionConfig(ctx: ExtensionContext): SessionConfig {
  if (ctx.mode !== 'tui') {
    return { credentials: undefined, minRunMs: DEFAULT_MIN_RUN_SECONDS * 1000 };
  }
  const botToken = process.env.PI_TELEGRAM_NOTIFY_BOT_TOKEN;
  const chatId = process.env.PI_TELEGRAM_NOTIFY_CHAT_ID;
  let credentials: SessionCredentials | undefined;
  if (botToken && chatId) {
    credentials = { botToken, chatId };
  } else {
    const missing: string[] = [];
    if (!botToken) {
      missing.push('PI_TELEGRAM_NOTIFY_BOT_TOKEN');
    }
    if (!chatId) {
      missing.push('PI_TELEGRAM_NOTIFY_CHAT_ID');
    }
    const names = missing.join(' and ');
    const verb = missing.length === 1 ? 'is' : 'are';
    try {
      ctx.ui.notify(
        `pi-telegram-notify: ${names} ${verb} not set; Telegram notifications are disabled for this session.`,
        'warning',
      );
    } catch {
      // A throwing notify must not stop the config from being applied.
    }
  }
  const minRun = minRunDurationMs();
  if (minRun.invalid !== undefined) {
    try {
      ctx.ui.notify(
        `pi-telegram-notify: PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS is invalid ("${minRun.invalid}"); using the default of ${DEFAULT_MIN_RUN_SECONDS} seconds.`,
        'warning',
      );
    } catch {
      // A throwing notify must not stop the config from being applied.
    }
  }
  return { credentials, minRunMs: minRun.ms };
}

// A network error warns with the error's own message and its `cause`, since
// `fetch` reports `fetch failed` and puts the real reason in `cause`.
function networkCause(error: unknown): string {
  if (error instanceof Error) {
    if (error.cause === undefined || error.cause === null || error.cause === '') {
      return error.message;
    }
    const causeText = error.cause instanceof Error ? error.cause.message : String(error.cause);
    return `${error.message}: ${causeText}`;
  }
  return String(error);
}

// Classifies a settled send: `undefined` when Telegram accepted it, else the
// real cause for the warning. Anything that is not the Bot API's JSON
// envelope — an unparseable body, or JSON without a boolean `ok` — is
// malformed, reported with its HTTP status. An `ok: false` envelope warns
// with Telegram's `description` verbatim.
async function failureCause(response: Response): Promise<string | undefined> {
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch (error) {
    // A body that fails mid-read is a transport failure, not a malformed
    // envelope: only unparseable JSON names the body. Anything else warns
    // with its own message and cause, like a network error.
    if (error instanceof SyntaxError) {
      return `malformed response (HTTP ${response.status})`;
    }
    return networkCause(error);
  }
  if (typeof envelope !== 'object' || envelope === null) {
    return `malformed response (HTTP ${response.status})`;
  }
  const record = envelope as { ok?: unknown; description?: unknown };
  if (typeof record.ok !== 'boolean') {
    return `malformed response (HTTP ${response.status})`;
  }
  if (record.ok) {
    return undefined;
  }
  if (typeof record.description !== 'string') {
    return `malformed response (HTTP ${response.status})`;
  }
  return record.description;
}

export class SessionNotifier {
  private readonly credentials: SessionCredentials | undefined;
  // The latest event's context, refreshed on every event the extension
  // handles. A send settles later, and a context captured earlier throws
  // after a session replacement or a reload, so the failure warning always
  // uses this one.
  private latestCtx: ExtensionContext | undefined;
  // Only the first failure in a row warns; a successful send re-arms the
  // warning.
  private failureWarned = false;
  // Set when the session shuts down: a send still in flight then is
  // dropped, and its late failure must not warn into a dead transcript.
  private closed = false;

  constructor(credentials: SessionCredentials | undefined, initialCtx?: ExtensionContext) {
    this.credentials = credentials;
    this.latestCtx = initialCtx;
  }

  updateCtx(ctx: ExtensionContext): void {
    this.latestCtx = ctx;
  }

  close(): void {
    this.closed = true;
  }

  // Warns about a failed send through the latest event's context. Never
  // warns after the session ended, and never throws, so a notification
  // problem cannot disturb the session.
  private warnFailure(cause: string): void {
    if (this.closed) {
      return;
    }
    const ctx = this.latestCtx;
    if (ctx === undefined) {
      return;
    }
    try {
      ctx.ui.notify(`pi-telegram-notify: failed to send notification: ${cause}`, 'warning');
    } catch {
      // A stale context (after /new, a switch, or a reload) throws; the
      // session matters more than the warning.
    }
  }

  // Posts one rendered text as a new message that rings (no
  // `disable_notification`), with link previews off. The send promise is
  // never returned and no failure path throws.
  notify(text: string): void {
    const credentials = this.credentials;
    if (credentials === undefined) {
      return;
    }
    const reportOnce = (cause: string): void => {
      if (this.failureWarned) {
        return;
      }
      this.failureWarned = true;
      try {
        this.warnFailure(cause);
      } catch {
        // The warning itself must never disturb the session.
      }
    };
    let pending: Promise<Response>;
    try {
      pending = fetch(`https://api.telegram.org/bot${credentials.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: credentials.chatId,
          text,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        }),
      });
    } catch (error) {
      // A synchronously-throwing fetch warns like a network error, still
      // without disturbing the session.
      reportOnce(networkCause(error));
      return;
    }
    void pending.then(
      (response) => {
        void failureCause(response).then(
          (cause) => {
            if (cause === undefined) {
              this.failureWarned = false;
            } else {
              reportOnce(cause);
            }
          },
          () => {
            reportOnce(`malformed response (HTTP ${response.status})`);
          },
        );
      },
      (error: unknown) => {
        reportOnce(networkCause(error));
      },
    );
  }
}
