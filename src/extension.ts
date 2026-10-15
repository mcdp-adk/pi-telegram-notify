// Extension entry: composes the run tracker, the message renderer, and
// the Telegram sender to send one notification when a run completes, ends
// with an error, or opens a dialog during a run in a `tui` session. Only
// `tui` sessions notify; aborted runs, idle dialogs, runs younger than
// PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS (default 60), and anything else return
// before the sender is reached. At session start a `tui` session with a
// missing bot token or chat id warns once and then sends nothing, as does an
// invalid minimum duration (which then falls back to the default). A send
// that fails warns once per
// outage with the real cause, through the latest event's context. No handler
// awaits a send, and no handler throws, so notifications can never disturb
// the session.
import { basename } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { renderNotification } from './message.ts';
import type { SessionIdentity } from './message.ts';
import type { DialogDue, SettledRun } from './run.ts';
import { RunTracker } from './run.ts';
import { sendTelegramMessage } from './telegram.ts';

// Minimum run age a notification requires, in seconds: a run that stops or
// opens a dialog sooner stays silent, so a quick run the developer watched
// never rings the phone. Zero notifies always.
const DEFAULT_MIN_RUN_SECONDS = 60;

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

// The single gate every notification passes: only `tui` sessions that
// started configured send. Returns the credentials to send with.
function telegramCredentials(
  ctx: ExtensionContext,
  misconfigured: boolean,
): { botToken: string; chatId: string } | undefined {
  if (ctx.mode !== 'tui' || misconfigured) {
    return undefined;
  }
  const botToken = process.env.PI_TELEGRAM_NOTIFY_BOT_TOKEN;
  const chatId = process.env.PI_TELEGRAM_NOTIFY_CHAT_ID;
  if (!botToken || !chatId) {
    return undefined;
  }
  return { botToken, chatId };
}

function sendIfReady(
  ctx: ExtensionContext,
  misconfigured: boolean,
  text: string,
  onFailure: (cause: string) => void,
): void {
  const credentials = telegramCredentials(ctx, misconfigured);
  if (credentials === undefined) {
    return;
  }
  sendTelegramMessage(credentials.botToken, credentials.chatId, text, onFailure);
}

// Identity of the session a notification belongs to, read when the
// notification is built so a mid-session rename shows in the next one.
function sessionIdentity(ctx: ExtensionContext): SessionIdentity {
  return {
    projectName: basename(ctx.cwd),
    sessionName: ctx.sessionManager.getSessionName(),
    sessionTag: ctx.sessionManager.getSessionId().slice(-4),
  };
}

function notifyCompleted(
  ctx: ExtensionContext,
  run: SettledRun,
  misconfigured: boolean,
  onFailure: (cause: string) => void,
): void {
  sendIfReady(
    ctx,
    misconfigured,
    renderNotification({
      status: 'completed',
      durationMs: run.durationMs,
      ...sessionIdentity(ctx),
      messages: run.messages,
    }),
    onFailure,
  );
}

function notifyError(
  ctx: ExtensionContext,
  run: SettledRun,
  misconfigured: boolean,
  onFailure: (cause: string) => void,
): void {
  sendIfReady(
    ctx,
    misconfigured,
    renderNotification({
      status: 'error',
      durationMs: run.durationMs,
      ...sessionIdentity(ctx),
      messages: run.messages,
    }),
    onFailure,
  );
}

function notifyDialog(
  ctx: ExtensionContext,
  title: string | undefined,
  due: DialogDue,
  misconfigured: boolean,
  onFailure: (cause: string) => void,
): void {
  sendIfReady(
    ctx,
    misconfigured,
    renderNotification({
      status: 'dialog',
      ...sessionIdentity(ctx),
      title,
      messages: due.messages,
    }),
    onFailure,
  );
}

export default function (pi: ExtensionAPI): void {
  // The session's run, tracked in one module; the handlers below only
  // translate pi events into its calls and render what it returns.
  const tracker = new RunTracker(DEFAULT_MIN_RUN_SECONDS * 1000);
  // Set at session start: a session that started without its configuration
  // warns once and then sends nothing, even if the variables appear later.
  let misconfigured = false;
  // The latest event's context, refreshed on every event the extension
  // handles. A send settles later, and a context captured earlier throws
  // after a session replacement or a reload, so the failure warning always
  // uses this one.
  let latestCtx: ExtensionContext | undefined;
  // Set when the session shuts down: a send still in flight then is dropped,
  // and its late failure must not warn into a dead transcript.
  let sessionEnded = false;

  // Warns about a failed send through the latest event's context. Never
  // warns after the session ended, and never throws, so a notification
  // problem cannot disturb the session.
  function warnSendFailure(cause: string): void {
    if (sessionEnded) {
      return;
    }
    const ctx = latestCtx;
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

  pi.on('session_start', (_event, ctx) => {
    latestCtx = ctx;
    sessionEnded = false;
    try {
      if (ctx.mode !== 'tui') {
        return;
      }
      const missing: string[] = [];
      if (!process.env.PI_TELEGRAM_NOTIFY_BOT_TOKEN) {
        missing.push('PI_TELEGRAM_NOTIFY_BOT_TOKEN');
      }
      if (!process.env.PI_TELEGRAM_NOTIFY_CHAT_ID) {
        missing.push('PI_TELEGRAM_NOTIFY_CHAT_ID');
      }
      if (missing.length === 0) {
        misconfigured = false;
      } else {
        misconfigured = true;
        const names = missing.join(' and ');
        const verb = missing.length === 1 ? 'is' : 'are';
        ctx.ui.notify(
          `pi-telegram-notify: ${names} ${verb} not set; Telegram notifications are disabled for this session.`,
          'warning',
        );
      }
      const minRun = minRunDurationMs();
      tracker.setMinRunMs(minRun.ms);
      if (minRun.invalid !== undefined) {
        ctx.ui.notify(
          `pi-telegram-notify: PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS is invalid ("${minRun.invalid}"); using the default of ${DEFAULT_MIN_RUN_SECONDS} seconds.`,
          'warning',
        );
      }
    } catch {
      // A warning must never break session start.
    }
  });

  pi.on('session_shutdown', () => {
    sessionEnded = true;
  });

  pi.on('before_agent_start', (_event, ctx) => {
    latestCtx = ctx;
    tracker.beginRun();
  });

  pi.on('message_end', (event, ctx) => {
    latestCtx = ctx;
    tracker.addMessage(event.message);
  });

  pi.on('agent_before_settle', (event, ctx) => {
    latestCtx = ctx;
    tracker.cacheOutcome(event.outcome);
  });

  pi.on('ui_prompt_start', (event, ctx) => {
    latestCtx = ctx;
    // A dialog notifies only while a run is in progress (`ctx.isIdle()` is
    // false): a dialog opened from a command while idle sends nothing. The
    // gate reads the session state, never this extension's own run record,
    // so a dialog from an extension ordered ahead — opened before this
    // handler's `before_agent_start` ran — still notifies, with whatever
    // reply exists so far, possibly none. The title is absent for
    // title-less dialogs. pi does not await this handler, so the send stays
    // fire-and-forget.
    const due = tracker.dialogDue(ctx.isIdle());
    if (due === undefined) {
      return;
    }
    try {
      notifyDialog(ctx, event.title, due, misconfigured, warnSendFailure);
    } catch {
      // Notification bookkeeping must never break the dialog.
    }
  });

  pi.on('agent_settled', (event, ctx) => {
    latestCtx = ctx;
    const finished = tracker.settle(event.aborted);
    if (finished === undefined) {
      return;
    }
    try {
      if (finished.status === 'error') {
        notifyError(ctx, finished, misconfigured, warnSendFailure);
      } else {
        notifyCompleted(ctx, finished, misconfigured, warnSendFailure);
      }
    } catch {
      // Notification bookkeeping must never break settlement.
    }
  });
}
