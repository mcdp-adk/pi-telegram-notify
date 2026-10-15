// A run younger than PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS sends nothing —
// neither a completed, error, nor dialog notification — while a run at or
// over the threshold notifies as before. All assertions go through the SDK
// seam (a scripted session plus the Telegram fetch stub), counting sends
// rather than re-proving the message shapes the other suites own.
import fs from 'node:fs';
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
import type { RecordedTelegramRequest, ScriptedReply, TestClock } from './harness.ts';

// Lets a recorded fire-and-forget send land, or proves none was issued,
// without reading the mocked clock.
async function drain(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('minimum run duration', () => {
  test('a short completed run sends nothing at the default threshold', async (t) => {
    // Primary owner: with the variable unset, a 1s run stays silent. A gate
    // that lets everything through sends here.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345', minRunSeconds: undefined });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('short-run-completed');
    const scripts: ScriptedReply[] = [{ kind: 'text', text: 'That was quick.', tickMs: 1_000 }];
    const { session } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));

    await session.prompt('do the thing');
    await drain();
    assert.equal(stub.requests.length, 0);
  });

  test('a short error run sends nothing at the default threshold', async (t) => {
    // Independent contract: errors get no exception — a fast failure the
    // developer watched needs no ring either. A gate that skips only
    // completed runs sends here.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345', minRunSeconds: undefined });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('short-run-error');
    const scripts: ScriptedReply[] = [
      { kind: 'error', text: 'Working on it.', errorMessage: 'Something broke', tickMs: 1_000 },
    ];
    const { session } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));

    await session.prompt('do the thing');
    await drain();
    assert.equal(stub.requests.length, 0);
  });

  test('a run below the threshold stays silent while a run at it notifies', async (t) => {
    // Independent contract: the gate is inclusive — 59s sends nothing, 60s
    // rings. An off-by-one in either direction fails one half here.
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cases = [
      { name: 'below', tickMs: 59_000, expected: 0 },
      { name: 'at', tickMs: 60_000, expected: 1 },
    ];
    for (const { name, tickMs, expected } of cases) {
      useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345', minRunSeconds: '60' });
      const stub = installTelegramFetchStub();
      clock.now = 1_700_000_000_000;
      const cwd = makeTempRoot(`short-run-boundary-${name}`);
      const scripts: ScriptedReply[] = [{ kind: 'text', text: 'Done.', tickMs }];
      const { session } = await createScriptedSession({ scripts, cwd, clock });
      try {
        await session.prompt('do the thing');
        if (expected === 0) {
          await drain();
        } else {
          await stub.waitForRequests(1);
        }
        assert.equal(stub.requests.length, expected);
        if (expected === 1) {
          assert.ok(String(stub.requests[0].body['text']).startsWith('✅ <b>Completed</b>'));
        }
      } finally {
        stub.restore();
        await shutdownSession(session);
      }
    }
  });

  test('an error run at the threshold notifies', async (t) => {
    // Independent contract: a 60s failure rings — the gate measures the
    // run, never its outcome. A gate that drops errors stays silent here.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345', minRunSeconds: '60' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('short-run-error-long');
    const scripts: ScriptedReply[] = [
      { kind: 'error', text: 'Working on it.', errorMessage: 'Something broke', tickMs: 60_000 },
    ];
    const { session } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));

    await session.prompt('do the thing');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
    assert.equal(requests.length, 1);
    assert.ok(String(requests[0].body['text']).startsWith('❌ <b>Error</b>'));
  });

  // A tool the faux model can call; executing it opens a confirm dialog the
  // way any other extension would, which is what the package under test
  // observes through `ui_prompt_start`.
  const confirmToolFactory: InlineExtension = async (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'ask_deploy',
      label: 'Ask deploy',
      description: 'Asks the developer to confirm the deploy.',
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        await ctx.ui.confirm('Deploy now?', 'Ship it?');
        return {
          content: [{ type: 'text', text: 'noted' }],
          details: undefined,
        };
      },
    });
  };

  test('a dialog early in a run sends nothing while the completed run notifies', async (t) => {
    // Independent contract: the dialog opens 1s into the run (silent) and
    // the run settles at 66s (rings once). A gate that ignores dialogs
    // sends twice here; one that ignores durations sends nothing.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345', minRunSeconds: '60' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('short-run-dialog-early');
    const scripts: ScriptedReply[] = [
      { kind: 'tool', name: 'ask_deploy', text: 'Let me confirm.', tickMs: 1_000 },
      { kind: 'text', text: 'Done shipping.', tickMs: 65_000 },
    ];
    const { session } = await createScriptedSession({
      scripts,
      cwd,
      clock,
      extensionFactories: [confirmToolFactory],
    });
    t.after(async () => shutdownSession(session));

    await session.prompt('ship it');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
    await drain();
    assert.equal(stub.requests.length, 1);
    assert.ok(String(requests[0].body['text']).startsWith('✅ <b>Completed</b>'));
  });

  test('a dialog late in a run notifies', async (t) => {
    // Independent contract: the dialog opens 65s into the run, so both the
    // dialog and the completed run ring. A gate stuck shut sends nothing.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345', minRunSeconds: '60' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('short-run-dialog-late');
    const scripts: ScriptedReply[] = [
      { kind: 'tool', name: 'ask_deploy', text: 'Let me confirm.', tickMs: 65_000 },
      { kind: 'text', text: 'Done shipping.', tickMs: 1_000 },
    ];
    const { session } = await createScriptedSession({
      scripts,
      cwd,
      clock,
      extensionFactories: [confirmToolFactory],
    });
    t.after(async () => shutdownSession(session));

    await session.prompt('ship it');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(2);
    assert.equal(requests.length, 2);
    assert.ok(String(requests[0].body['text']).startsWith('❓ <b>Waiting for you</b>'));
    assert.ok(String(requests[1].body['text']).startsWith('✅ <b>Completed</b>'));
  });

  // A package ordered ahead of the package under test: its
  // `before_agent_start` opens a dialog before this extension records the
  // run, so the dialog arrives with no run record. Written to disk because
  // package discovery loads packages, never inline factories, first.
  function writeForeignDialogPackage(): string {
    const dir = makeTempRoot('short-run-foreign-pkg');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'foreign-dialog-pkg',
        version: '0.0.0',
        type: 'module',
        pi: { extensions: ['./foreign-extension.ts'] },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'foreign-extension.ts'),
      `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';\n` +
        `\n` +
        `export default function (pi: ExtensionAPI): void {\n` +
        `  pi.on('before_agent_start', async (_event, ctx) => {\n` +
        `    await ctx.ui.confirm('Foreign title?', 'Proceed?');\n` +
        `  });\n` +
        `}\n`,
    );
    return dir;
  }

  test('a dialog with no run record stays silent at the default threshold', async (t) => {
    // Independent contract: with no run record the run just started, so the
    // dialog counts as elapsed zero — and the 1s run after it stays silent
    // too. A gate that notifies record-less dialogs sends here.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345', minRunSeconds: undefined });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('short-run-foreign');
    const scripts: ScriptedReply[] = [{ kind: 'text', text: 'Done after the early dialog.', tickMs: 1_000 }];
    const { session } = await createScriptedSession({
      scripts,
      cwd,
      clock,
      earlierPackages: [writeForeignDialogPackage()],
    });
    t.after(async () => shutdownSession(session));

    await session.prompt('start');
    await drain();
    assert.equal(stub.requests.length, 0);
  });

  test('threshold 0 notifies an instant run', async (t) => {
    // Independent contract: `0` restores notifying always — even a run with
    // no measurable duration rings.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345', minRunSeconds: '0' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('short-run-zero');
    const scripts: ScriptedReply[] = [{ kind: 'text', text: 'Instant.' }];
    const { session } = await createScriptedSession({ scripts, cwd, clock });
    t.after(async () => shutdownSession(session));

    await session.prompt('do the thing');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
    assert.equal(requests.length, 1);
    assert.ok(String(requests[0].body['text']).startsWith('✅ <b>Completed</b>'));
  });

  test('a dialog with no run record notifies when the threshold is 0', async (t) => {
    // Independent contract: the record-less dialog counts as elapsed zero,
    // which reaches a zero threshold — both the dialog and the instant run
    // ring. A gate that drops record-less dialogs sends nothing here.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345', minRunSeconds: '0' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('short-run-foreign-zero');
    const scripts: ScriptedReply[] = [{ kind: 'text', text: 'Done after the early dialog.' }];
    const { session } = await createScriptedSession({
      scripts,
      cwd,
      clock,
      earlierPackages: [writeForeignDialogPackage()],
    });
    t.after(async () => shutdownSession(session));

    await session.prompt('start');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(2);
    assert.equal(requests.length, 2);
    assert.ok(String(requests[0].body['text']).startsWith('❓ <b>Waiting for you</b>'));
  });

  test('an invalid threshold warns once and behaves as the default', async (t) => {
    // Independent contract: a non-numeric or negative value warns at session
    // start and falls back to 60s — the 1s run stays silent, the 61s run
    // rings. A fallback to zero would send twice; a disabled gate nothing.
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    for (const raw of ['abc', '-5']) {
      useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345', minRunSeconds: raw });
      const stub = installTelegramFetchStub();
      clock.now = 1_700_000_000_000;
      const cwd = makeTempRoot(`short-run-invalid-${raw}`);
      const scripts: ScriptedReply[] = [
        { kind: 'text', text: 'First run.', tickMs: 1_000 },
        { kind: 'text', text: 'Second run.', tickMs: 61_000 },
      ];
      const { session, notifications } = await createScriptedSession({ scripts, cwd, clock });
      try {
        assert.deepEqual(notifications, [
          {
            message:
              `pi-telegram-notify: PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS is invalid ("${raw}"); ` +
              'using the default of 60 seconds.',
            level: 'warning',
          },
        ]);
        await session.prompt('first');
        await session.prompt('second');
        const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
        await drain();
        assert.equal(stub.requests.length, 1);
        assert.ok(String(requests[0].body['text']).startsWith('✅ <b>Completed</b>'));
      } finally {
        stub.restore();
        await shutdownSession(session);
      }
    }
  });
});
