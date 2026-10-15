// Extension entry: tracks the current run from pi's events and sends one
// Telegram notification when a run completes, ends with an error, or opens
// a dialog during a run in a `tui` session. Only `tui` sessions notify;
// aborted runs, idle dialogs, and anything else return before the sender is
// reached. At session start a `tui` session with a missing bot token or chat
// id warns once and then sends nothing. A send that fails warns once per
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
import { sendTelegramMessage } from './telegram.ts';

type RunMessage = Extract<MessageEndEvent['message'], { role: 'assistant' }>;

interface ActiveRun {
  startTimeMs: number;
  messages: RunMessage[];
  outcome: AgentActivityOutcome | undefined;
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
      projectName: basename(ctx.cwd),
      sessionName: ctx.sessionManager.getSessionName(),
      sessionTag: ctx.sessionManager.getSessionId().slice(-4),
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
      projectName: basename(ctx.cwd),
      sessionName: ctx.sessionManager.getSessionName(),
      sessionTag: ctx.sessionManager.getSessionId().slice(-4),
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
      projectName: basename(ctx.cwd),
      sessionName: ctx.sessionManager.getSessionName(),
      sessionTag: ctx.sessionManager.getSessionId().slice(-4),
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
        return;
      }
      misconfigured = true;
      const names = missing.join(' and ');
      const verb = missing.length === 1 ? 'is' : 'are';
      ctx.ui.notify(
        `pi-telegram-notify: ${names} ${verb} not set; Telegram notifications are disabled for this session.`,
        'warning',
      );
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
    // A dialog notifies only while its run is still in progress: a dialog
    // opened from a command while idle sends nothing. The title is absent
    // for title-less dialogs; the excerpt is the run's latest reply so far.
    // pi does not await this handler, so the send stays fire-and-forget.
    if (run === undefined || ctx.isIdle()) {
      return;
    }
    try {
      notifyDialog(ctx, event.title, latestReplyText(run.messages), misconfigured, warnSendFailure);
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
