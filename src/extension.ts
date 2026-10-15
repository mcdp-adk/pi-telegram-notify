// Extension entry: tracks the current run from pi's events and sends one
// Telegram notification when a run completes, ends with an error, or opens
// a dialog during a run in a `tui` session. Only `tui` sessions notify;
// aborted runs, idle dialogs, runs younger than
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
  AgentActivityOutcome,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from '@earendil-works/pi-coding-agent';
import { renderNotification } from './message.ts';
import type { SessionIdentity } from './message.ts';
import { sendTelegramMessage } from './telegram.ts';

type RunMessage = Extract<MessageEndEvent['message'], { role: 'assistant' }>;

interface ActiveRun {
  startTimeMs: number;
  messages: RunMessage[];
  outcome: AgentActivityOutcome | undefined;
}

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
  run: ActiveRun,
  misconfigured: boolean,
  onFailure: (cause: string) => void,
): void {
  sendIfReady(
    ctx,
    misconfigured,
    renderNotification({
      status: 'completed',
      durationMs: Date.now() - run.startTimeMs,
      ...sessionIdentity(ctx),
      excerpt: latestReplyText(run.messages),
    }),
    onFailure,
  );
}

function notifyError(
  ctx: ExtensionContext,
  run: ActiveRun,
  misconfigured: boolean,
  onFailure: (cause: string) => void,
): void {
  sendIfReady(
    ctx,
    misconfigured,
    renderNotification({
      status: 'error',
      durationMs: Date.now() - run.startTimeMs,
      ...sessionIdentity(ctx),
      detail: lastErrorMessage(run.messages),
      excerpt: latestReplyText(run.messages),
    }),
    onFailure,
  );
}

function notifyDialog(
  ctx: ExtensionContext,
  title: string | undefined,
  excerpt: string | undefined,
  misconfigured: boolean,
  onFailure: (cause: string) => void,
): void {
  sendIfReady(
    ctx,
    misconfigured,
    renderNotification({
      status: 'dialog',
      ...sessionIdentity(ctx),
      detail: title,
      excerpt,
    }),
    onFailure,
  );
}

export default function (pi: ExtensionAPI): void {
  let run: ActiveRun | undefined;
  // Set at session start: a session that started without its configuration
  // warns once and then sends nothing, even if the variables appear later.
  let misconfigured = false;
  // Set at session start: the run age a notification requires. Read here so
  // a value exported mid-session never changes a running session's mind.
  let minRunMs = DEFAULT_MIN_RUN_SECONDS * 1000;
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
      minRunMs = minRun.ms;
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
    if (run === undefined) {
      run = { startTimeMs: Date.now(), messages: [], outcome: undefined };
    }
  });

  pi.on('message_end', (event, ctx) => {
    latestCtx = ctx;
    if (run !== undefined && event.message.role === 'assistant') {
      run.messages.push(event.message);
    }
  });

  pi.on('agent_before_settle', (event, ctx) => {
    latestCtx = ctx;
    if (run !== undefined) {
      run.outcome = event.outcome;
    }
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
    if (ctx.isIdle()) {
      return;
    }
    // A dialog in a young run stays silent: under the minimum the developer
    // is still watching. With no run record the run just started, so
    // elapsed counts from zero and notifies only when the minimum is zero.
    const dialogAgeMs = run === undefined ? 0 : Date.now() - run.startTimeMs;
    if (dialogAgeMs < minRunMs) {
      return;
    }
    try {
      notifyDialog(ctx, event.title, run === undefined ? undefined : latestReplyText(run.messages), misconfigured, warnSendFailure);
    } catch {
      // Notification bookkeeping must never break the dialog.
    }
  });

  pi.on('agent_settled', (event, ctx) => {
    latestCtx = ctx;
    // The settle event reports whether the run was aborted (Escape or
    // another extension's `ctx.abort()`), whatever outcome was cached
    // earlier: an aborted run sends nothing.
    if (event.aborted) {
      run = undefined;
      return;
    }
    const finished = run;
    run = undefined;
    if (finished === undefined || (finished.outcome !== 'completed' && finished.outcome !== 'error')) {
      return;
    }
    // A short run stays silent, whatever its outcome: the developer watched
    // a run this quick and needs no ring for it.
    if (Date.now() - finished.startTimeMs < minRunMs) {
      return;
    }
    try {
      if (finished.outcome === 'error') {
        notifyError(ctx, finished, misconfigured, warnSendFailure);
      } else {
        notifyCompleted(ctx, finished, misconfigured, warnSendFailure);
      }
    } catch {
      // Notification bookkeeping must never break settlement.
    }
  });
}
