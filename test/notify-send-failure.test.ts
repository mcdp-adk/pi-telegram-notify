// A send that fails warns in pi with the real cause, only the
// first failure in a row, and is never retried.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScriptedRuntime,
  createScriptedSession,
  installTelegramFetchStub,
  makeTempRoot,
  shutdownRuntime,
  shutdownSession,
  useTelegramEnv,
} from './harness.ts';
import type { RecordedNotification, ScriptedReply } from './harness.ts';

// Sends are fire-and-forget, so a test that expects a warning polls the
// recorded notifications, never a fixed delay.
async function waitForWarnings(notifications: RecordedNotification[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (notifications.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${count} warnings (got ${notifications.length})`);
}

// A failed send is never retried: once the warning lands, draining the loop
// must record no further request.
async function drain(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('failed send', () => {
  test('an ok:false response warns with Telegram’s description verbatim', async (t) => {
    // Independent contract: the warning names the extension and carries
    // Telegram's `description` word for word. A paraphrase or a missing
    // warning fails here.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub([{ kind: 'bot-error', description: 'Bad Request: chat not found' }]);
    t.after(() => stub.restore());
    const cwd = makeTempRoot('send-failure-bot-error');
    const scripts: ScriptedReply[] = [{ kind: 'text', text: 'Only run.' }];
    const { session, notifications } = await createScriptedSession({ scripts, cwd });
    t.after(async () => shutdownSession(session));

    await session.prompt('only');
    await stub.waitForRequests(1);
    await waitForWarnings(notifications, 1);
    await drain();
    assert.equal(stub.requests.length, 1);
    assert.deepEqual(notifications, [
      {
        message: 'pi-telegram-notify: failed to send notification: Bad Request: chat not found',
        level: 'warning',
      },
    ]);
  });

  test('a network error warns with its message and its cause', async (t) => {
    // Independent contract: `fetch` reports `fetch failed` and puts the
    // real reason in `cause`, so the warning carries both. A warning with
    // only the outer message fails here.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub([
      { kind: 'network-error', message: 'fetch failed', cause: new Error('connect ECONNREFUSED') },
    ]);
    t.after(() => stub.restore());
    const cwd = makeTempRoot('send-failure-network');
    const scripts: ScriptedReply[] = [{ kind: 'text', text: 'Only run.' }];
    const { session, notifications } = await createScriptedSession({ scripts, cwd });
    t.after(async () => shutdownSession(session));

    await session.prompt('only');
    await stub.waitForRequests(1);
    await waitForWarnings(notifications, 1);
    await drain();
    assert.equal(stub.requests.length, 1);
    assert.deepEqual(notifications, [
      {
        message: 'pi-telegram-notify: failed to send notification: fetch failed: connect ECONNREFUSED',
        level: 'warning',
      },
    ]);
  });

  test('a body read failure warns with its message and its cause', async (t) => {
    // Independent contract: when the response body fails mid-read (a socket
    // dying under Telegram's JSON), the warning carries the transport
    // error's own message and cause — never `malformed response`, which
    // would name the wrong culprit.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub([
      { kind: 'body-error', message: 'terminated', cause: new Error('socket hang up') },
    ]);
    t.after(() => stub.restore());
    const cwd = makeTempRoot('send-failure-body-error');
    const scripts: ScriptedReply[] = [{ kind: 'text', text: 'Only run.' }];
    const { session, notifications } = await createScriptedSession({ scripts, cwd });
    t.after(async () => shutdownSession(session));

    await session.prompt('only');
    await stub.waitForRequests(1);
    await waitForWarnings(notifications, 1);
    await drain();
    assert.equal(stub.requests.length, 1);
    assert.deepEqual(notifications, [
      {
        message: 'pi-telegram-notify: failed to send notification: terminated: socket hang up',
        level: 'warning',
      },
    ]);
  });

  test('a non-envelope response warns as malformed with its HTTP status', async (t) => {
    // Independent contract: a body that is not the Bot API's JSON envelope —
    // a proxy error page, or JSON without a boolean `ok` — warns as
    // malformed with the HTTP status, never with a paraphrase of the body.
    // The success between the two failures re-arms the warning, so both warn.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub([
      { kind: 'malformed', status: 502, body: '<html><body>Bad Gateway</body></html>' },
      { kind: 'ok' },
      { kind: 'malformed', status: 200, body: '{"foo":1}' },
    ]);
    t.after(() => stub.restore());
    const cwd = makeTempRoot('send-failure-malformed');
    const scripts: ScriptedReply[] = [
      { kind: 'text', text: 'First run.' },
      { kind: 'text', text: 'Second run.' },
      { kind: 'text', text: 'Third run.' },
    ];
    const { session, notifications } = await createScriptedSession({ scripts, cwd });
    t.after(async () => shutdownSession(session));

    await session.prompt('first');
    await session.prompt('second');
    await session.prompt('third');
    await stub.waitForRequests(3);
    await waitForWarnings(notifications, 2);
    await drain();
    assert.equal(stub.requests.length, 3);
    assert.deepEqual(notifications, [
      {
        message: 'pi-telegram-notify: failed to send notification: malformed response (HTTP 502)',
        level: 'warning',
      },
      {
        message: 'pi-telegram-notify: failed to send notification: malformed response (HTTP 200)',
        level: 'warning',
      },
    ]);
  });

  test('only the first failure in a row warns until a success re-arms', async (t) => {
    // Independent contract: consecutive failures warn once, and a success
    // re-arms so a later failure warns again. A warning per failure fails
    // the count; a warning that never comes back after a success fails the
    // re-arm.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub([
      { kind: 'bot-error', description: 'Bad Request: chat not found' },
      { kind: 'bot-error', description: 'Bad Request: chat not found' },
      { kind: 'ok' },
      { kind: 'bot-error', description: 'Unauthorized' },
    ]);
    t.after(() => stub.restore());
    const cwd = makeTempRoot('send-failure-rearm');
    const scripts: ScriptedReply[] = [
      { kind: 'text', text: 'First run.' },
      { kind: 'text', text: 'Second run.' },
      { kind: 'text', text: 'Third run.' },
      { kind: 'text', text: 'Fourth run.' },
    ];
    const { session, notifications } = await createScriptedSession({ scripts, cwd });
    t.after(async () => shutdownSession(session));

    await session.prompt('first');
    await session.prompt('second');
    await session.prompt('third');
    await session.prompt('fourth');
    await stub.waitForRequests(4);
    await waitForWarnings(notifications, 2);
    await drain();
    assert.equal(stub.requests.length, 4);
    assert.deepEqual(notifications, [
      {
        message: 'pi-telegram-notify: failed to send notification: Bad Request: chat not found',
        level: 'warning',
      },
      {
        message: 'pi-telegram-notify: failed to send notification: Unauthorized',
        level: 'warning',
      },
    ]);
  });

  test('skips the warning once the session has ended', async (t) => {
    // Independent contract: a send still in flight at shutdown warns
    // nowhere — even with the runner still alive (as between a reload's
    // shutdown and its start), the late failure is dropped. Only the
    // extension's own ended-flag can drop it here, so removing the flag
    // warns and fails this test.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub([
      { kind: 'ok' },
      { kind: 'bot-error', description: 'Unauthorized', delayMs: 100 },
    ]);
    t.after(() => stub.restore());
    const cwd = makeTempRoot('send-failure-after-shutdown');
    const scripts: ScriptedReply[] = [
      { kind: 'text', text: 'First run.' },
      { kind: 'text', text: 'Second run.' },
    ];
    const { session, notifications } = await createScriptedSession({ scripts, cwd });
    t.after(async () => shutdownSession(session));

    await session.prompt('first');
    await stub.waitForRequests(1);
    await session.prompt('second');
    await stub.waitForRequests(2);
    // Shuts down without disposing the runner, so the recorded UI context
    // stays live and the late failure reaches the warning path.
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' });
    // The delayed failure lands after the shutdown was handled: no fixed
    // delay, the stub signals the settled fetch and the drain flushes the
    // warning path that follows it.
    await stub.waitForSettled(2);
    await drain();
    assert.equal(stub.requests.length, 2);
    assert.deepEqual(notifications, [] as RecordedNotification[]);
  });

  test('a restarted session warns again about an ongoing outage', async (t) => {
    // Independent contract: the warn-once latch belongs to the session,
    // not the process. pi's `/new` tears the current runtime down
    // (`session_shutdown` fires), then creates a new runtime in the same
    // cwd and invokes the extension factory again, so the replacement
    // session gets a new closure while the module cache stays shared.
    // While the outage continues, the replacement session's failed send
    // warns again. A process-global latch stays silent after the restart
    // and fails this test at its second waitForWarnings.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub([
      { kind: 'bot-error', description: 'Bad Request: chat not found' },
      { kind: 'bot-error', description: 'Bad Request: chat not found' },
    ]);
    t.after(() => stub.restore());
    const cwd = makeTempRoot('send-failure-session-restart');
    const scripts: ScriptedReply[] = [
      { kind: 'text', text: 'First run.' },
      { kind: 'text', text: 'Second run.' },
    ];
    const { runtime, notifications } = await createScriptedRuntime({ scripts, cwd });
    t.after(async () => shutdownRuntime(runtime));
    const expected: RecordedNotification = {
      message: 'pi-telegram-notify: failed to send notification: Bad Request: chat not found',
      level: 'warning',
    };

    await runtime.session.prompt('first');
    await stub.waitForRequests(1);
    await waitForWarnings(notifications, 1);
    // pi's real replacement path in the same cwd: the old session ends
    // with `session_shutdown` and the replacement session starts anew.
    await runtime.newSession();
    await runtime.session.prompt('second');
    await stub.waitForRequests(2);
    await waitForWarnings(notifications, 2);
    await drain();
    assert.equal(stub.requests.length, 2);
    assert.deepEqual(notifications, [expected, expected]);
  });
});
