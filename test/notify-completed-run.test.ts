// Ticket #17: a completed run sends one Telegram notification that rings.
import path from 'node:path';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScriptedSession,
  installTelegramFetchStub,
  makeTempRoot,
  shutdownSession,
  useTelegramEnv,
} from './harness.ts';
import type { RecordedNotification, RecordedTelegramRequest, ScriptedReply, TestClock } from './harness.ts';

describe('completed run', () => {
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
});
