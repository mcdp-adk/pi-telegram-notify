// A `tui` session with missing configuration warns once at
// session start and then sends nothing.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createScriptedSession,
  installTelegramFetchStub,
  makeTempRoot,
  shutdownSession,
  useTelegramEnv,
} from './harness.ts';

describe('missing configuration', () => {
  test('names both missing variables and sends nothing', async (t) => {
    // Independent contract: with neither variable set, session start shows
    // exactly one warning naming both, and a completed run still sends no
    // Telegram request. A silent return without the warning fails the first
    // assertion; a send despite the warning fails the second.
    useTelegramEnv(t, { botToken: undefined, chatId: undefined });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const cwd = makeTempRoot('missing-both');
    const { session, notifications } = await createScriptedSession({
      scripts: [{ kind: 'text', text: 'All done.' }],
      cwd,
    });
    t.after(async () => shutdownSession(session));

    assert.deepEqual(notifications, [
      {
        message:
          'pi-telegram-notify: PI_TELEGRAM_NOTIFY_BOT_TOKEN and PI_TELEGRAM_NOTIFY_CHAT_ID are not set; ' +
          'Telegram notifications are disabled for this session.',
        level: 'warning',
      },
    ]);

    await session.prompt('do the thing');
    assert.equal(stub.requests.length, 0);
  });

  test('names only the missing bot token', async (t) => {
    // Independent contract: with only the chat id set, the warning names
    // the bot token and never the chat id. A warning that always lists both
    // variables fails here while passing the both-missing test.
    useTelegramEnv(t, { botToken: undefined, chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const cwd = makeTempRoot('missing-token');
    const { session, notifications } = await createScriptedSession({
      scripts: [{ kind: 'text', text: 'All done.' }],
      cwd,
    });
    t.after(async () => shutdownSession(session));

    assert.deepEqual(notifications, [
      {
        message:
          'pi-telegram-notify: PI_TELEGRAM_NOTIFY_BOT_TOKEN is not set; ' +
          'Telegram notifications are disabled for this session.',
        level: 'warning',
      },
    ]);

    await session.prompt('do the thing');
    assert.equal(stub.requests.length, 0);
  });

  test('names only the missing chat id', async (t) => {
    // Independent contract: with only the bot token set, the warning names
    // the chat id and never the bot token. Mirrors the token-only test for
    // the other variable.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: undefined });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const cwd = makeTempRoot('missing-chat');
    const { session, notifications } = await createScriptedSession({
      scripts: [{ kind: 'text', text: 'All done.' }],
      cwd,
    });
    t.after(async () => shutdownSession(session));

    assert.deepEqual(notifications, [
      {
        message:
          'pi-telegram-notify: PI_TELEGRAM_NOTIFY_CHAT_ID is not set; ' +
          'Telegram notifications are disabled for this session.',
        level: 'warning',
      },
    ]);

    await session.prompt('do the thing');
    assert.equal(stub.requests.length, 0);
  });

  test('treats empty variables as missing', async (t) => {
    // Independent contract: an empty string is the same as unset (a shell
    // export with no value). A check for `undefined` only would stay silent
    // here and fail this test.
    useTelegramEnv(t, { botToken: '', chatId: '' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const cwd = makeTempRoot('missing-empty');
    const { session, notifications } = await createScriptedSession({
      scripts: [{ kind: 'text', text: 'All done.' }],
      cwd,
    });
    t.after(async () => shutdownSession(session));

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, 'warning');
    assert.match(notifications[0].message, /PI_TELEGRAM_NOTIFY_BOT_TOKEN/);
    assert.match(notifications[0].message, /PI_TELEGRAM_NOTIFY_CHAT_ID/);

    await session.prompt('do the thing');
    assert.equal(stub.requests.length, 0);
  });

  test('never warns outside the tui', async (t) => {
    // Independent contract: the same missing configuration under another
    // mode stays silent — no warning at session start. A mode-unaware
    // session_start handler fails here.
    useTelegramEnv(t, { botToken: undefined, chatId: undefined });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const cwd = makeTempRoot('missing-non-tui');
    const { session, notifications } = await createScriptedSession({
      scripts: [{ kind: 'text', text: 'All done.' }],
      cwd,
      mode: 'rpc',
    });
    t.after(async () => shutdownSession(session));

    assert.deepEqual(notifications, []);
    await session.prompt('do the thing');
    assert.equal(stub.requests.length, 0);
  });
});
