// Extension entry: tracks the current run from pi's events and sends one
// Telegram notification when a run completes or ends with an error in a
// `tui` session. Only `tui` sessions and settled runs with an outcome of
// `completed` or `error` notify; aborted runs and anything else return
// before the sender is reached. At session start a `tui` session with a
// missing bot token or chat id warns once and then sends nothing. A send
// that fails warns once per outage with the real cause, through the latest
// event's context. No handler awaits a send, and no handler throws, so
// notifications can never disturb the session. Later tickets add the
// dialog shape.
import { basename } from 'node:path';
import type {
  AgentActivityOutcome,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from '@earendil-works/pi-coding-agent';
import { renderCompletedNotification, renderErrorNotification } from './message.ts';
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

function notifyCompleted(
  ctx: ExtensionContext,
  run: ActiveRun,
  misconfigured: boolean,
  onFailure: (cause: string) => void,
): void {
  if (ctx.mode !== 'tui') {
    return;
  }
  if (misconfigured) {
    return;
  }
  const botToken = process.env.PI_TELEGRAM_NOTIFY_BOT_TOKEN;
  const chatId = process.env.PI_TELEGRAM_NOTIFY_CHAT_ID;
  if (!botToken || !chatId) {
    return;
  }
  sendTelegramMessage(
    botToken,
    chatId,
    renderCompletedNotification({
      durationMs: Date.now() - run.startTimeMs,
      projectName: basename(ctx.cwd),
      sessionName: ctx.sessionManager.getSessionName(),
      sessionTag: ctx.sessionManager.getSessionId().slice(-4),
      excerpt: latestReplyText(run.messages),
    }),
    onFailure,
  );
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

function notifyError(
  ctx: ExtensionContext,
  run: ActiveRun,
  misconfigured: boolean,
  onFailure: (cause: string) => void,
): void {
  if (ctx.mode !== 'tui') {
    return;
  }
  if (misconfigured) {
    return;
  }
  const botToken = process.env.PI_TELEGRAM_NOTIFY_BOT_TOKEN;
  const chatId = process.env.PI_TELEGRAM_NOTIFY_CHAT_ID;
  if (!botToken || !chatId) {
    return;
  }
  sendTelegramMessage(
    botToken,
    chatId,
    renderErrorNotification({
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

  pi.on('agent_settled', (_event, ctx) => {
    latestCtx = ctx;
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
