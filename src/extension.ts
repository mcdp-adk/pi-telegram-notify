// Extension entry: tracks the current run from pi's events and sends one
// Telegram notification when a run completes or ends with an error in a
// `tui` session. Only `tui` sessions and settled runs with an outcome of
// `completed` or `error` notify; aborted runs and anything else return
// before the sender is reached. No handler awaits a send, and no handler
// throws, so notifications can never disturb the session. Later tickets add
// dialogs and the missing-configuration and send-failure warnings.
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

// The run's last assistant message's error message, never an earlier
// one's. A failed tool call carries no message of its own, so only the
// run's outcome decides between the completed and error shapes.
function lastErrorMessage(messages: RunMessage[]): string | undefined {
  if (messages.length === 0) {
    return undefined;
  }
  return messages[messages.length - 1].errorMessage;
}

function notifyCompleted(ctx: ExtensionContext, run: ActiveRun): void {
  if (ctx.mode !== 'tui') {
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
  );
}

function notifyError(ctx: ExtensionContext, run: ActiveRun): void {
  if (ctx.mode !== 'tui') {
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
  );
}

export default function (pi: ExtensionAPI): void {
  let run: ActiveRun | undefined;

  pi.on('before_agent_start', () => {
    if (run === undefined) {
      run = { startTimeMs: Date.now(), messages: [], outcome: undefined };
    }
  });

  pi.on('message_end', (event) => {
    if (run !== undefined && event.message.role === 'assistant') {
      run.messages.push(event.message);
    }
  });

  pi.on('agent_before_settle', (event) => {
    if (run !== undefined) {
      run.outcome = event.outcome;
    }
  });

  pi.on('agent_settled', (_event, ctx) => {
    const finished = run;
    run = undefined;
    if (finished === undefined || (finished.outcome !== 'completed' && finished.outcome !== 'error')) {
      return;
    }
    try {
      if (finished.outcome === 'error') {
        notifyError(ctx, finished);
      } else {
        notifyCompleted(ctx, finished);
      }
    } catch {
      // Notification bookkeeping must never break settlement.
    }
  });
}
