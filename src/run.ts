// Run tracker: owns the current run's state and every rule that decides
// whether a notification is due, so the extension handlers stay thin
// translators of pi events. The clock is `Date.now`, which tests mock.
//
// Run invariants:
// - At most one run is open. `beginRun` opens one only when none is open;
//   a second `before_agent_start` while open changes nothing.
// - Only assistant messages that end while a run is open are kept, in
//   order. A dialog with no run record (an extension ordered ahead opened
//   it before our `before_agent_start` ran) carries no messages, never
//   another run's.
// - The outcome cached from `agent_before_settle` decides the settle
//   shape; the settle event's `aborted` flag always wins over it, and an
//   aborted run sends nothing and keeps nothing.
// - Age counts from the run's start to the settle or dialog moment. A
//   dialog with no run record counts as age zero, so it notifies only when
//   the minimum is zero.
// - `settle` always closes the run, whether it notifies or stays silent;
//   a dialog never closes it.
import type {
  AgentActivityOutcome,
  MessageEndEvent,
} from '@earendil-works/pi-coding-agent';

export type RunMessage = Extract<MessageEndEvent['message'], { role: 'assistant' }>;

// A run that settled and is due a notification: its outcome, its full
// duration, and the run's own messages for the renderer to select from.
// Ownership of the messages moves to the caller; the tracker keeps none.
export interface SettledRun {
  status: 'completed' | 'error';
  durationMs: number;
  messages: RunMessage[];
}

// A dialog that is due a notification: the run's messages so far for the
// renderer to select from, or undefined when there is no run record. The
// tracker keeps the run open; the caller must not keep the messages.
export interface DialogDue {
  messages: RunMessage[] | undefined;
}

export class RunTracker {
  private run:
    | {
        startTimeMs: number;
        messages: RunMessage[];
        outcome: AgentActivityOutcome | undefined;
      }
    | undefined;
  // The run age a notification requires. Set at session start, so a value
  // exported mid-session never changes a running session's mind.
  private minRunMs: number;

  constructor(minRunMs: number) {
    this.minRunMs = minRunMs;
  }

  setMinRunMs(minRunMs: number): void {
    this.minRunMs = minRunMs;
  }

  beginRun(): void {
    if (this.run === undefined) {
      this.run = { startTimeMs: Date.now(), messages: [], outcome: undefined };
    }
  }

  addMessage(message: MessageEndEvent['message']): void {
    if (this.run !== undefined && message.role === 'assistant') {
      this.run.messages.push(message);
    }
  }

  cacheOutcome(outcome: AgentActivityOutcome): void {
    if (this.run !== undefined) {
      this.run.outcome = outcome;
    }
  }

  // A dialog notifies only while a run is in progress, which the caller
  // reads from the session (`ctx.isIdle()`), never from this tracker's own
  // record — so a dialog from an extension ordered ahead still notifies.
  dialogDue(isIdle: boolean): DialogDue | undefined {
    if (isIdle) {
      return undefined;
    }
    // With no run record the run just started, so elapsed counts from zero
    // and notifies only when the minimum is zero.
    const ageMs = this.run === undefined ? 0 : Date.now() - this.run.startTimeMs;
    if (ageMs < this.minRunMs) {
      return undefined;
    }
    return { messages: this.run === undefined ? undefined : this.run.messages };
  }

  settle(aborted: boolean): SettledRun | undefined {
    // The settle event reports whether the run was aborted (Escape or
    // another extension's `ctx.abort()`), whatever outcome was cached
    // earlier: an aborted run sends nothing.
    if (aborted) {
      this.run = undefined;
      return undefined;
    }
    const finished = this.run;
    this.run = undefined;
    if (finished === undefined || (finished.outcome !== 'completed' && finished.outcome !== 'error')) {
      return undefined;
    }
    // A short run stays silent, whatever its outcome: the developer watched
    // a run this quick and needs no ring for it.
    const durationMs = Date.now() - finished.startTimeMs;
    if (durationMs < this.minRunMs) {
      return undefined;
    }
    return { status: finished.outcome, durationMs, messages: finished.messages };
  }
}
