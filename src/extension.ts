// Extension entry: a thin composition root. The run tracker (src/run.ts)
// follows each run from pi's events and decides whether a notification is
// due; the renderer (src/message.ts) selects the reply text and shapes the
// Telegram HTML; the session's sender (src/notifier.ts), created at session
// start, posts it. Only `tui` sessions notify; aborted runs, idle dialogs,
// runs younger than PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS (default 60), and
// anything else return before the sender is reached. No handler awaits a
// send, and no handler throws, so notifications can never disturb the
// session.
import { basename } from 'node:path';
import type {
  AgentBeforeSettleEvent,
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  UIPromptStartEvent,
} from '@earendil-works/pi-coding-agent';
import { renderNotification } from './message.ts';
import type { SessionIdentity } from './message.ts';
import { DEFAULT_MIN_RUN_SECONDS, readSessionConfig, SessionNotifier } from './notifier.ts';
import { RunTracker } from './run.ts';

// Identity of the session a notification belongs to, read when the
// notification is built so a mid-session rename shows in the next one.
function sessionIdentity(ctx: ExtensionContext): SessionIdentity {
  return {
    projectName: basename(ctx.cwd),
    sessionName: ctx.sessionManager.getSessionName(),
    sessionTag: ctx.sessionManager.getSessionId().slice(-4),
  };
}

export default function (pi: ExtensionAPI): void {
  // The session's run, tracked in one module; the handlers below only
  // translate pi events into its calls and render what it returns. pi
  // gives each runtime a new closure, so replacing the tracker and the
  // sender below at session start is defence in depth.
  let tracker = new RunTracker(DEFAULT_MIN_RUN_SECONDS * 1000);
  // The session's sender, created at session start. Before the first start
  // it sends nothing.
  let sender: SessionNotifier = new SessionNotifier(undefined);

  // Every run or dialog event refreshes the sender's latest context first,
  // in this one place: a send settles later, and a context captured earlier
  // throws after a session replacement or a reload.
  function tracked<E, R>(handler: (event: E, ctx: ExtensionContext) => R): (event: E, ctx: ExtensionContext) => R {
    return (event, ctx) => {
      sender.updateCtx(ctx);
      return handler(event, ctx);
    };
  }

  pi.on('session_start', (_event, ctx) => {
    try {
      const config = readSessionConfig(ctx);
      // Closes the previous sender before replacing it, so a send still
      // in flight from the old session can never warn into the new one;
      // a fresh tracker means an open run can never cross sessions.
      sender.close();
      tracker = new RunTracker(config.minRunMs);
      sender = new SessionNotifier(config.credentials, ctx);
    } catch {
      // Configuration and warnings must never break session start.
    }
  });

  pi.on('session_shutdown', () => {
    sender.close();
  });

  pi.on(
    'before_agent_start',
    tracked((_event: BeforeAgentStartEvent, _ctx) => {
      tracker.beginRun();
    }),
  );

  pi.on(
    'message_end',
    tracked((event: MessageEndEvent, _ctx) => {
      tracker.addMessage(event.message);
    }),
  );

  pi.on(
    'agent_before_settle',
    tracked((event: AgentBeforeSettleEvent, _ctx) => {
      tracker.cacheOutcome(event.outcome);
    }),
  );

  pi.on(
    'ui_prompt_start',
    tracked((event: UIPromptStartEvent, ctx) => {
      // A dialog notifies only while a run is in progress (`ctx.isIdle()`
      // is false): a dialog opened from a command while idle sends nothing.
      // The gate reads the session state, never this extension's own run
      // record, so a dialog from an extension ordered ahead — opened before
      // this handler's `before_agent_start` ran — still notifies, with
      // whatever reply exists so far, possibly none. The title is absent
      // for title-less dialogs. pi does not await this handler, so the send
      // stays fire-and-forget.
      const due = tracker.dialogDue(ctx.isIdle());
      if (due === undefined) {
        return;
      }
      try {
        sender.notify(
          renderNotification({
            status: 'dialog',
            ...sessionIdentity(ctx),
            title: event.title,
            messages: due.messages,
          }),
        );
      } catch {
        // Notification bookkeeping must never break the dialog.
      }
    }),
  );

  pi.on(
    'agent_settled',
    tracked((event: AgentSettledEvent, ctx) => {
      const finished = tracker.settle(event.aborted);
      if (finished === undefined) {
        return;
      }
      try {
        sender.notify(
          renderNotification({
            status: finished.status,
            durationMs: finished.durationMs,
            ...sessionIdentity(ctx),
            messages: finished.messages,
          }),
        );
      } catch {
        // Notification bookkeeping must never break settlement.
      }
    }),
  );
}
