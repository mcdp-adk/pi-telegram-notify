// Extension entry: tracks the current run from pi's events and sends one
// Telegram notification when a run completes or a dialog opens during a run
// in a `tui` session. Only `tui` sessions notify; anything else returns
// before the sender is reached. No handler awaits a send, and no handler
// throws, so notifications can never disturb the session. Later tickets add
// the error outcome and the missing-configuration and send-failure warnings.
import { basename } from 'node:path';
import type {
  AgentActivityOutcome,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
} from '@earendil-works/pi-coding-agent';
import { renderCompletedNotification, renderDialogNotification } from './message.ts';
import { sendTelegramMessage } from './telegram.ts';

type RunMessage = MessageEndEvent['message'];

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

function notifyDialog(ctx: ExtensionContext, title: string | undefined, excerpt: string | undefined): void {
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
    renderDialogNotification({
      projectName: basename(ctx.cwd),
      sessionName: ctx.sessionManager.getSessionName(),
      sessionTag: ctx.sessionManager.getSessionId().slice(-4),
      title,
      excerpt,
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

  pi.on('ui_prompt_start', (event, ctx) => {
    // A dialog notifies only while its run is still in progress: a dialog
    // opened from a command while idle sends nothing. The title is absent
    // for title-less dialogs; the excerpt is the run's latest reply so far.
    // pi does not await this handler, so the send stays fire-and-forget.
    if (run === undefined || ctx.isIdle()) {
      return;
    }
    try {
      notifyDialog(ctx, event.title, latestReplyText(run.messages));
    } catch {
      // Notification bookkeeping must never break the dialog.
    }
  });

  pi.on('agent_settled', (_event, ctx) => {
    const finished = run;
    run = undefined;
    if (finished === undefined || finished.outcome !== 'completed') {
      return;
    }
    try {
      notifyCompleted(ctx, finished);
    } catch {
      // Notification bookkeeping must never break settlement.
    }
  });
}
