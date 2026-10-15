// Ticket #18: an error run notifies with the error message, an aborted run
// stays silent, and a failed tool call still completes. All assertions go
// through the SDK seam (a scripted session plus the Telegram fetch stub),
// never the renderer or sender directly.
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';
import {
  createScriptedSession,
  echoToolFactory,
  installTelegramFetchStub,
  makeTempRoot,
  shutdownSession,
  useTelegramEnv,
} from './harness.ts';
import type { RecordedTelegramRequest, ScriptedReply, TestClock } from './harness.ts';

describe('error run', () => {
  test('sends the error status with the collapsed error message and excerpt', async (t) => {
    // Primary owner: the error shape — ❌ Error header, bold error detail,
    // then the excerpt. A completed-only implementation sends nothing here.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('error-basic');
    const scripts: ScriptedReply[] = [
      { kind: 'error', text: 'Working on it.', errorMessage: 'Something broke', tickMs: 41_000 },
    ];
    const { session, sessionManager } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));

    await session.prompt('do the thing');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
    assert.equal(stub.requests.length, 1);

    const tag = sessionManager.getSessionId().slice(-4);
    assert.equal(
      requests[0].body['text'],
      `❌ <b>Error</b> · 41s · #s${tag}\n` +
        `${path.basename(cwd)}\n` +
        `\n` +
        `<b>Something broke</b>\n` +
        `<blockquote expandable>Working on it.</blockquote>`,
    );
  });

  test('sends the error message when the run has no reply text', async (t) => {
    // Independent contract: a run that failed mid-reply has no excerpt, so
    // the message is the header plus the bold detail — never the header
    // alone. An implementation that drops detail-less excerpts stays silent.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('error-no-text');
    const scripts: ScriptedReply[] = [{ kind: 'error', errorMessage: 'Provider blew up', tickMs: 1_000 }];
    const { session, sessionManager } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));

    await session.prompt('do the thing');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
    assert.equal(stub.requests.length, 1);
    assert.equal(
      requests[0].body['text'],
      `❌ <b>Error</b> · 1s · #s${sessionManager.getSessionId().slice(-4)}\n` +
        `${path.basename(cwd)}\n` +
        `\n` +
        `<b>Provider blew up</b>`,
    );
  });

  test('falls back to the last message with text and uses only the last error', async (t) => {
    // Independent contract: when the failing message has no text, the
    // excerpt comes from the run's last message that has text — never from
    // an earlier run — while the detail stays the last message's own
    // error. An implementation reading the first error or an older run
    // shows the wrong cause or context here.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('error-fallback');
    const scripts: ScriptedReply[] = [
      { kind: 'text', text: 'Older run reply.', tickMs: 1_000 },
      { kind: 'tool', name: 'echo_note', args: { note: 'hi' }, text: 'Checking now.', tickMs: 1_000 },
      { kind: 'error', errorMessage: 'Final failure', tickMs: 1_000 },
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
    const project = path.basename(cwd);
    assert.equal(
      requests[0].body['text'],
      `✅ <b>Completed</b> · 1s · #s${tag}\n${project}\n\n<blockquote expandable>Older run reply.</blockquote>`,
    );
    assert.equal(
      requests[1].body['text'],
      `❌ <b>Error</b> · 2s · #s${tag}\n` +
        `${project}\n` +
        `\n` +
        `<b>Final failure</b>\n` +
        // The second run consumes two scripted replies (tool turn plus the
        // failing message), ticking the clock twice; the excerpt falls back
        // to the tool turn's text, never the older run or the tool result.
        `<blockquote expandable>Checking now.</blockquote>`,
    );
  });

  test('collapses the detail to one line, cuts it, and escapes after cutting', async (t) => {
    // Independent contract: the bold detail is one line — newlines and runs
    // of whitespace become single spaces — kept to ~300 characters with a
    // trailing …, then escaped. Cutting before escaping keeps 299 x's here,
    // not fewer; an escape-first implementation would keep fewer.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('error-detail-cut');
    const scripts: ScriptedReply[] = [
      {
        kind: 'error',
        text: 'Reply.',
        errorMessage: `  Failure\nwith\nlines <&> ${'x'.repeat(299)}tail`,
        tickMs: 1_000,
      },
    ];
    const { session, sessionManager } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));

    await session.prompt('do the thing');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
    assert.equal(stub.requests.length, 1);
    // "Failure with lines <&> " is 23 collapsed characters, so the head
    // keeps it plus the next 276 x's, then …; the tail is dropped.
    const expectedDetail = `Failure with lines &lt;&amp;&gt; ${'x'.repeat(276)}…`;
    assert.equal(
      requests[0].body['text'],
      `❌ <b>Error</b> · 1s · #s${sessionManager.getSessionId().slice(-4)}\n` +
        `${path.basename(cwd)}\n` +
        `\n` +
        `<b>${expectedDetail}</b>\n` +
        `<blockquote expandable>Reply.</blockquote>`,
    );
  });

  test('omits an empty error message and shows the excerpt', async (t) => {
    // Independent contract: whitespace-only detail is omitted, leaving the
    // header plus the excerpt. An implementation that bolds the raw message
    // shows an empty bold line here.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('error-empty-detail');
    const scripts: ScriptedReply[] = [
      { kind: 'error', text: 'Partial reply.', errorMessage: '   \n  ', tickMs: 1_000 },
    ];
    const { session, sessionManager } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));

    await session.prompt('do the thing');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
    assert.equal(stub.requests.length, 1);
    assert.equal(
      requests[0].body['text'],
      `❌ <b>Error</b> · 1s · #s${sessionManager.getSessionId().slice(-4)}\n` +
        `${path.basename(cwd)}\n` +
        `\n` +
        `<blockquote expandable>Partial reply.</blockquote>`,
    );
  });

  test('a failed tool call still notifies as completed', async (t) => {
    // Independent contract: a tool result with isError ends the turn in
    // error, but the run carries on and settles completed — only the run's
    // outcome decides the shape. An implementation that notifies ❌ Error on
    // any tool failure sends the wrong status here.
    const failToolFactory: InlineExtension = async (pi: ExtensionAPI) => {
      pi.registerTool({
        name: 'fail_op',
        label: 'Fail op',
        description: 'Always fails.',
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: 'text', text: 'boom' }],
          details: undefined,
          isError: true,
        }),
      });
    };
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('error-tool-fails');
    const scripts: ScriptedReply[] = [
      { kind: 'tool', name: 'fail_op', text: 'Trying.', tickMs: 1_000 },
      { kind: 'text', text: 'Recovered.', tickMs: 1_000 },
    ];
    const { session, sessionManager } = await createScriptedSession({
      scripts,
      cwd,
      clock,
      extensionFactories: [failToolFactory],
    });
    t.after(async () => shutdownSession(session));

    await session.prompt('do the thing');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
    assert.equal(stub.requests.length, 1);
    assert.equal(
      requests[0].body['text'],
      `✅ <b>Completed</b> · 2s · #s${sessionManager.getSessionId().slice(-4)}\n` +
        `${path.basename(cwd)}\n` +
        `\n` +
        `<blockquote expandable>Recovered.</blockquote>`,
    );
  });

  test('an aborted run sends nothing', { timeout: 30_000 }, async (t) => {
    // Independent contract: Escape aborts the run, and the developer at the
    // computer already knows — no notification follows. The second prompt
    // proves the silence: it notifies once, so the abort itself sent
    // nothing. An implementation that notifies on every settle sends twice.
    let toolStarted = false;
    const blockingToolFactory: InlineExtension = async (pi: ExtensionAPI) => {
      pi.registerTool({
        name: 'block_forever',
        label: 'Block forever',
        description: 'Waits until aborted.',
        parameters: Type.Object({}),
        execute: async (_toolCallId, _params, signal) => {
          toolStarted = true;
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error('aborted'));
              return;
            }
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
          return { content: [{ type: 'text', text: 'never' }], details: undefined };
        },
      });
    };
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('error-aborted');
    const scripts: ScriptedReply[] = [
      { kind: 'tool', name: 'block_forever', text: 'Starting.', tickMs: 1_000 },
      { kind: 'text', text: 'Second run done.', tickMs: 1_000 },
    ];
    const { session, sessionManager } = await createScriptedSession({
      scripts,
      cwd,
      clock,
      extensionFactories: [blockingToolFactory],
    });
    t.after(async () => shutdownSession(session));

    const first = session.prompt('first');
    for (let attempt = 0; attempt < 1000 && !toolStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(toolStarted, true);
    await session.abort();
    await first;
    // The abort settled the run: give the fire-and-forget send a chance to
    // (not) record, then prove the stub works with a completing run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stub.requests.length, 0);

    await session.prompt('second');
    const requests = await stub.waitForRequests(1);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].body['text'],
      `✅ <b>Completed</b> · 1s · #s${sessionManager.getSessionId().slice(-4)}\n` +
        `${path.basename(cwd)}\n` +
        `\n` +
        `<blockquote expandable>Second run done.</blockquote>`,
    );
  });

  test('sends nothing when another extension aborts the run during settle', async (t) => {
    // Regression: another extension may call `ctx.abort()` in
    // `agent_before_settle` after this extension already cached a completed
    // outcome. The settle event still reports aborted, so nothing is sent.
    // The second prompt proves the silence: it notifies once, so the aborted
    // settle itself sent nothing.
    let abortOnce = true;
    const abortDuringSettleFactory: InlineExtension = async (pi: ExtensionAPI) => {
      pi.on('agent_before_settle', (_event, ctx) => {
        if (abortOnce) {
          abortOnce = false;
          ctx.abort();
        }
      });
    };
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('error-abort-during-settle');
    const scripts: ScriptedReply[] = [
      { kind: 'text', text: 'First run.', tickMs: 1_000 },
      { kind: 'text', text: 'Second run.', tickMs: 1_000 },
    ];
    const { session, sessionManager } = await createScriptedSession({
      scripts,
      cwd,
      clock,
      extensionFactories: [abortDuringSettleFactory],
    });
    t.after(async () => shutdownSession(session));

    await session.prompt('first');
    // The abort settled the run: give the fire-and-forget send a chance to
    // (not) record, then prove the stub works with a completing run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stub.requests.length, 0);

    await session.prompt('second');
    const requests = await stub.waitForRequests(1);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].body['text'],
      `✅ <b>Completed</b> · 1s · #s${sessionManager.getSessionId().slice(-4)}\n` +
        `${path.basename(cwd)}\n` +
        `\n` +
        `<blockquote expandable>Second run.</blockquote>`,
    );
  });

  test('a misconfigured session sends nothing for an error run', async (t) => {
    // Merge seam: the missing-configuration gate threads through the error
    // path too — with neither variable set, an error run warns at session
    // start and sends no Telegram request. An error notifier that skips the
    // gate sends here.
    useTelegramEnv(t, { botToken: undefined, chatId: undefined });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const cwd = makeTempRoot('error-misconfigured');
    const scripts: ScriptedReply[] = [
      { kind: 'error', text: 'Working on it.', errorMessage: 'Something broke' },
    ];
    const { session } = await createScriptedSession({ scripts, cwd });
    t.after(async () => shutdownSession(session));

    await session.prompt('do the thing');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stub.requests.length, 0);
  });
});
