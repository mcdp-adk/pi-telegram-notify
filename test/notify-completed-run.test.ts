// Ticket #17: a completed run sends one Telegram notification that rings.
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import {
  createScriptedSession,
  installTelegramFetchStub,
  makeTempRoot,
  shutdownSession,
  useTelegramEnv,
} from './harness.ts';
import type { RecordedNotification, RecordedTelegramRequest, ScriptedReply, TestClock } from './harness.ts';

describe('completed run', () => {
  // A tool the faux model can call, so a run holds more than one assistant
  // message. Its result text must never leak into the excerpt: only
  // assistant text counts.
  const echoToolFactory: InlineExtension = async (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'echo_note',
      label: 'Echo note',
      description: 'Returns its input as tool result text.',
      parameters: Type.Object({ note: Type.String() }),
      execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => ({
        content: [{ type: 'text', text: `echo:${params.note}` }],
        details: undefined,
      }),
    });
  };

  test('sends one sendMessage with the exact completed HTML', async (t) => {
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    // The extension measures the run with `Date.now`, so the suite owns the
    // clock: it starts fixed and advances from the scripted reply step.
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    // The mock owns the clock from here: pi and the extension read it too.
    assert.equal(Date.now(), clock.now);
    const cwd = makeTempRoot('completed-basic');
    const scripts: ScriptedReply[] = [{ kind: 'text', text: 'All done. Here is the summary.', tickMs: 41_000 }];
    const { session, sessionManager, notifications } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));

    await session.prompt('do the thing');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
    const request = requests[0];
    // The send is fire-and-forget, issued synchronously in the settle
    // handler: once the run settled, a second send would already be
    // recorded, so draining the loop proves there is exactly one.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stub.requests.length, 1);
    // A successful notified run shows the developer no warnings.
    assert.deepEqual(notifications, [] as RecordedNotification[]);

    const tag = sessionManager.getSessionId().slice(-4);
    assert.equal(request.url, 'https://api.telegram.org/bottest-bot-token/sendMessage');
    assert.equal(request.method, 'POST');
    assert.deepEqual(request.body, {
      chat_id: '12345',
      text:
        `✅ <b>Completed</b> · 41s · #s${tag}\n` +
        `${path.basename(cwd)}\n` +
        `\n` +
        `<blockquote expandable>All done. Here is the summary.</blockquote>`,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  test('writes minutes and hours compactly', async (t) => {
    // Independent contract: the first line carries `12m 34s` under an hour
    // and `1h 05m` beyond it, seconds and minutes padded to two digits.
    // A padding or rollover regression shows here, never in the 41s test.
    const cases = [
      { name: 'minutes', tickMs: 754_000, duration: '12m 34s' },
      { name: 'hours', tickMs: 3_900_000, duration: '1h 05m' },
    ];
    // One clock mock for the whole test: each case rewinds it before its run.
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    for (const { name, tickMs, duration } of cases) {
      useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
      const stub = installTelegramFetchStub();
      clock.now = 1_700_000_000_000;
      const cwd = makeTempRoot(`completed-duration-${name}`);
      const scripts: ScriptedReply[] = [{ kind: 'text', text: 'Finished.', tickMs }];
      const { session, sessionManager } = await createScriptedSession({ scripts, cwd, clock });
      try {
        await session.prompt('do the thing');
        const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
        const tag = sessionManager.getSessionId().slice(-4);
        assert.equal(
          requests[0].body['text'],
          `✅ <b>Completed</b> · ${duration} · #s${tag}\n` +
            `${path.basename(cwd)}\n` +
            `\n` +
            `<blockquote expandable>Finished.</blockquote>`,
        );
      } finally {
        stub.restore();
        await shutdownSession(session);
      }
    }
  });

  test('names the session only when set, reading it per notification', async (t) => {
    // Independent contract: an unnamed session shows the project alone, and
    // a name set between runs shows up in the later notification — the name
    // is read when the notification is built, never cached at session start.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('completed-session-name');
    const scripts: ScriptedReply[] = [
      { kind: 'text', text: 'First run.', tickMs: 1_000 },
      { kind: 'text', text: 'Second run.', tickMs: 2_000 },
    ];
    const { session, sessionManager } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));

    await session.prompt('first');
    sessionManager.appendSessionInfo('my feature');
    await session.prompt('second');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(2);
    assert.equal(requests.length, 2);

    const project = path.basename(cwd);
    const tag = sessionManager.getSessionId().slice(-4);
    assert.equal(
      requests[0].body['text'],
      `✅ <b>Completed</b> · 1s · #s${tag}\n` + `${project}\n` + `\n` + `<blockquote expandable>First run.</blockquote>`,
    );
    assert.equal(
      requests[1].body['text'],
      `✅ <b>Completed</b> · 2s · #s${tag}\n` +
        `${project} · my feature\n` +
        `\n` +
        `<blockquote expandable>Second run.</blockquote>`,
    );
  });

  test('falls back within the run, never to an earlier run', async (t) => {
    // Independent contract: when the run's last assistant message has no
    // text, the excerpt is the run's last message that has text — not a
    // tool result, and never a message from the previous run.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('completed-excerpt-fallback');
    const scripts: ScriptedReply[] = [
      { kind: 'text', text: 'Older run reply.', tickMs: 1_000 },
      { kind: 'tool', name: 'echo_note', args: { note: 'hi' }, text: 'Checking now.', tickMs: 1_000 },
      { kind: 'text', text: '', tickMs: 1_000 },
    ];
    const { session, sessionManager } = await createScriptedSession({
      scripts,
      cwd,
      clock,
      extensionFactories: [echoToolFactory],
    });
    t.after(async () => shutdownSession(session));

    await session.prompt('first');
    await session.prompt('second');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(2);
    assert.equal(requests.length, 2);

    const tag = sessionManager.getSessionId().slice(-4);
    const headline = (seconds: number) => `✅ <b>Completed</b> · ${seconds}s · #s${tag}\n${path.basename(cwd)}\n\n`;
    assert.equal(
      requests[0].body['text'],
      `${headline(1)}<blockquote expandable>Older run reply.</blockquote>`,
    );
    assert.equal(
      requests[1].body['text'],
      // The second run consumes two scripted replies (tool turn plus the
      // empty final text), ticking the clock twice.
      `${headline(2)}<blockquote expandable>Checking now.</blockquote>`,
    );
  });

  test('sends the header alone when the run has no reply text', async (t) => {
    // Independent contract: with no assistant text in the run, the message
    // is the header alone — no blank line, no empty quote.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('completed-empty');
    const scripts: ScriptedReply[] = [{ kind: 'text', text: '', tickMs: 1_000 }];
    const { session, sessionManager } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));

    await session.prompt('do the thing');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].body['text'],
      `✅ <b>Completed</b> · 1s · #s${sessionManager.getSessionId().slice(-4)}\n${path.basename(cwd)}`,
    );
  });

  test('cuts long excerpts and escapes markup', async (t) => {
    // Independent contract: the cut keeps the last 799 raw characters under
    // a leading …, then escapes — so the tail's `<&>` arrives as entities
    // and the session name's `&`/`<`/`>` do too. An escape-first
    // implementation would keep 786 x's here, not 796.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('completed-escape');
    const scripts: ScriptedReply[] = [{ kind: 'text', text: `${'x'.repeat(799)}<&>`, tickMs: 1_000 }];
    const { session, sessionManager } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));
    sessionManager.appendSessionInfo('a&b<c>');

    await session.prompt('do the thing');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].body['text'],
      `✅ <b>Completed</b> · 1s · #s${sessionManager.getSessionId().slice(-4)}\n` +
        `${path.basename(cwd)} · a&amp;b&lt;c&gt;\n` +
        `\n` +
        `<blockquote expandable>…${'x'.repeat(796)}&lt;&amp;&gt;</blockquote>`,
    );
  });

  test('sends nothing outside the tui', async (t) => {
    // Independent contract: the same completed run under another mode stays
    // silent — and the run itself still works.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('completed-non-tui');
    const scripts: ScriptedReply[] = [{ kind: 'text', text: 'All done.', tickMs: 41_000 }];
    const { session } = await createScriptedSession({ scripts, cwd, clock, mode: 'rpc' });
    t.after(async () => shutdownSession(session));

    await session.prompt('do the thing');
    assert.equal(stub.requests.length, 0);
  });

  test('a never-settling send blocks neither the settle nor the next prompt', { timeout: 30_000 }, async (t) => {
    // Independent contract: the send runs behind the run — the settle, and
    // the prompt after it, both resolve while Telegram never answers. The
    // timeout is the assertion: a blocking send would hang this test.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub({ kind: 'never' });
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('completed-never-settles');
    const scripts: ScriptedReply[] = [
      { kind: 'text', text: 'First run.', tickMs: 1_000 },
      { kind: 'text', text: 'Second run.', tickMs: 1_000 },
    ];
    const { session } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));

    await session.prompt('first');
    await stub.waitForRequests(1);
    await session.prompt('second');
    await stub.waitForRequests(2);
    assert.equal(stub.requests.length, 2);
  });

  test('a failed send never crashes the run', async (t) => {
    // Independent contract: a rejected send and a Telegram error answer both
    // resolve the run quietly — #17 reports nothing yet.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub([
      { kind: 'network-error', message: 'socket hang up' },
      { kind: 'bot-error', description: 'Bad Request: chat not found' },
    ]);
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('completed-send-fails');
    const scripts: ScriptedReply[] = [
      { kind: 'text', text: 'First run.', tickMs: 1_000 },
      { kind: 'text', text: 'Second run.', tickMs: 1_000 },
    ];
    const { session, notifications } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));

    await session.prompt('first');
    await session.prompt('second');
    const requests = await stub.waitForRequests(2);
    assert.equal(requests.length, 2);
    assert.deepEqual(notifications, [] as RecordedNotification[]);
  });
});
