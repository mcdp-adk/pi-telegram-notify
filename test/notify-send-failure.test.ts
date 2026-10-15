// Ticket #21: a send that fails warns in pi with the real cause, only the
// first failure in a row, and is never retried.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScriptedSession,
  installTelegramFetchStub,
  makeTempRoot,
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
    const stub = installTelegramFetchStub([
      { kind: 'ok' },
      { kind: 'bot-error', description: 'Bad Request: chat not found' },
    ]);
    t.after(() => stub.restore());
    const cwd = makeTempRoot('send-failure-bot-error');
    const scripts: ScriptedReply[] = [
      { kind: 'text', text: 'First run.' },
      { kind: 'text', text: 'Second run.' },
    ];
    const { session, notifications } = await createScriptedSession({ scripts, cwd });
    t.after(async () => shutdownSession(session));

    // The warmup send succeeds, so the failure below warns whatever earlier
    // suites in this process left behind: a success always re-arms.
    await session.prompt('first');
    await stub.waitForRequests(1);
    await session.prompt('second');
    await stub.waitForRequests(2);
    await waitForWarnings(notifications, 1);
    await drain();
    assert.equal(stub.requests.length, 2);
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
      { kind: 'ok' },
      { kind: 'network-error', message: 'fetch failed', cause: new Error('connect ECONNREFUSED') },
    ]);
    t.after(() => stub.restore());
    const cwd = makeTempRoot('send-failure-network');
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
    await waitForWarnings(notifications, 1);
    await drain();
    assert.equal(stub.requests.length, 2);
    assert.deepEqual(notifications, [
      {
        message: 'pi-telegram-notify: failed to send notification: fetch failed: connect ECONNREFUSED',
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
      { kind: 'ok' },
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
      { kind: 'text', text: 'Fourth run.' },
    ];
    const { session, notifications } = await createScriptedSession({ scripts, cwd });
    t.after(async () => shutdownSession(session));

    await session.prompt('first');
    await stub.waitForRequests(1);
    await session.prompt('second');
    await session.prompt('third');
    await session.prompt('fourth');
    await stub.waitForRequests(4);
    await waitForWarnings(notifications, 2);
    await drain();
    assert.equal(stub.requests.length, 4);
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
      { kind: 'ok' },
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
      { kind: 'text', text: 'Fifth run.' },
    ];
    const { session, notifications } = await createScriptedSession({ scripts, cwd });
    t.after(async () => shutdownSession(session));

    await session.prompt('first');
    await stub.waitForRequests(1);
    await session.prompt('second');
    await session.prompt('third');
    await session.prompt('fourth');
    await session.prompt('fifth');
    await stub.waitForRequests(5);
    await waitForWarnings(notifications, 2);
    await drain();
    assert.equal(stub.requests.length, 5);
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
    // Lets the delayed failure land after the shutdown was handled.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(stub.requests.length, 2);
    assert.deepEqual(notifications, [] as RecordedNotification[]);
  });
});
