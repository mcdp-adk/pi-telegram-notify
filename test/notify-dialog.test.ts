// A dialog opened during a run sends one Telegram notification
// that rings. A dialog opened while no run is in progress stays silent.
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

describe('dialog during a run', () => {
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
        await ctx.ui.confirm('Deploy <prod> & now?', 'Ship it?');
        return {
          content: [{ type: 'text', text: 'noted' }],
          details: undefined,
        };
      },
    });
  };

  test('sends waiting-for-you with the title and the latest reply so far', async (t) => {
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('dialog-basic');
    const scripts: ScriptedReply[] = [
      { kind: 'tool', name: 'ask_deploy', text: 'Let me confirm before shipping. <&>', tickMs: 1_000 },
      { kind: 'text', text: 'Done shipping.', tickMs: 1_000 },
    ];
    const { session, sessionManager } = await createScriptedSession({
      scripts,
      cwd,
      clock,
      extensionFactories: [confirmToolFactory],
    });
    t.after(async () => shutdownSession(session));

    await session.prompt('ship it');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(2);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stub.requests.length, 2);

    const tag = sessionManager.getSessionId().slice(-4);
    const project = path.basename(cwd);
    assert.equal(
      requests[0].body['text'],
      `❓ <b>Waiting for you</b> · #s${tag}\n` +
        `${project}\n` +
        `\n` +
        `<b>Deploy &lt;prod&gt; &amp; now?</b>\n` +
        `<blockquote expandable>Let me confirm before shipping. &lt;&amp;&gt;</blockquote>`,
    );
    assert.equal(
      requests[1].body['text'],
      `✅ <b>Completed</b> · 2s · #s${tag}\n` +
        `${project}\n` +
        `\n` +
        `<blockquote expandable>Done shipping.</blockquote>`,
    );
  });

  test('notifies a dialog opened by an earlier extension before our run starts', async (t) => {
    // Regression: an extension ordered ahead of this one opens its dialog
    // in its own `before_agent_start`, before this extension records the
    // run. The session is already busy, so the dialog still notifies — with
    // the title and no excerpt, since no reply exists yet.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('dialog-foreign');
    const scripts: ScriptedReply[] = [{ kind: 'text', text: 'Done after the early dialog.', tickMs: 1_000 }];
    const { session, sessionManager } = await createScriptedSession({
      scripts,
      cwd,
      clock,
      earlierPackages: [writeForeignDialogPackage()],
    });
    t.after(async () => shutdownSession(session));

    await session.prompt('start');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(2);
    assert.equal(requests.length, 2);

    const tag = sessionManager.getSessionId().slice(-4);
    const project = path.basename(cwd);
    assert.equal(
      requests[0].body['text'],
      `❓ <b>Waiting for you</b> · #s${tag}\n` +
        `${project}\n` +
        `\n` +
        `<b>Foreign &lt;title&gt; &amp; go?</b>`,
    );
    assert.equal(
      requests[1].body['text'],
      `✅ <b>Completed</b> · 1s · #s${tag}\n` +
        `${project}\n` +
        `\n` +
        `<blockquote expandable>Done after the early dialog.</blockquote>`,
    );
  });

  test('sends the header and the excerpt when the dialog has no title', async (t) => {
    // Independent contract: a title-less dialog (here a `custom` one, the
    // only kind without a title) still notifies — with no empty bold line.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('dialog-no-title');
    const customToolFactory: InlineExtension = async (pi: ExtensionAPI) => {
      pi.registerTool({
        name: 'ask_custom',
        label: 'Ask custom',
        description: 'Opens a title-less custom dialog.',
        parameters: Type.Object({}),
        execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
          // `custom` normally takes a component factory; the harness stub
          // ignores it, and only the dialog kind (title-less) reaches the
          // package under test.
          await ctx.ui.custom((() => undefined) as unknown as never);
          return {
            content: [{ type: 'text', text: 'noted' }],
            details: undefined,
          };
        },
      });
    };
    const scripts: ScriptedReply[] = [
      { kind: 'tool', name: 'ask_custom', text: 'Picking.', tickMs: 1_000 },
      { kind: 'text', text: 'Done.', tickMs: 1_000 },
    ];
    const { session, sessionManager } = await createScriptedSession({
      scripts,
      cwd,
      clock,
      extensionFactories: [customToolFactory],
    });
    t.after(async () => shutdownSession(session));

    await session.prompt('pick one');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(2);
    assert.equal(requests.length, 2);

    const tag = sessionManager.getSessionId().slice(-4);
    assert.equal(
      requests[0].body['text'],
      `❓ <b>Waiting for you</b> · #s${tag}\n` +
        `${path.basename(cwd)}\n` +
        `\n` +
        `<blockquote expandable>Picking.</blockquote>`,
    );
  });

  // A package ordered ahead of the package under test: its
  // `before_agent_start` opens a dialog before this extension records the
  // run. Written to disk because package discovery loads packages, never
  // inline factories, first.
  function writeForeignDialogPackage(): string {
    const dir = makeTempRoot('dialog-foreign-pkg');
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
        `    await ctx.ui.confirm('Foreign <title> & go?', 'Proceed?');\n` +
        `  });\n` +
        `}\n`,
    );
    return dir;
  }

  test('sends nothing for a dialog opened while no run is in progress', async (t) => {
    // Independent contract: a dialog the developer opens from a command
    // while idle stays silent — and the run after it still notifies alone.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('dialog-idle');
    const idleCommandFactory: InlineExtension = async (pi: ExtensionAPI) => {
      pi.registerCommand('askidle', {
        description: 'Opens a dialog while idle.',
        handler: async (_args, ctx) => {
          const answer = await ctx.ui.confirm('Idle question?', 'Are you there?');
          ctx.ui.notify(`answer:${answer}`, 'info');
        },
      });
    };
    const scripts: ScriptedReply[] = [{ kind: 'text', text: 'Back at the computer.', tickMs: 1_000 }];
    const { session, sessionManager, notifications } = await createScriptedSession({
      scripts,
      cwd,
      clock,
      extensionFactories: [idleCommandFactory],
    });
    t.after(async () => shutdownSession(session));

    await session.prompt('/askidle');
    // The notify proves the command ran and its dialog resolved.
    assert.deepEqual(notifications, [{ message: 'answer:false', level: 'info' }]);
    // The dialog event reaches the package through an async emit, so drain
    // the loop before proving it sent nothing.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stub.requests.length, 0);

    await session.prompt('do real work');
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(1);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stub.requests.length, 1);
    assert.equal(
      requests[0].body['text'],
      `✅ <b>Completed</b> · 1s · #s${sessionManager.getSessionId().slice(-4)}\n` +
        `${path.basename(cwd)}\n` +
        `\n` +
        `<blockquote expandable>Back at the computer.</blockquote>`,
    );
  });

  test('counts the open dialog in the run duration', async (t) => {
    // Independent contract: the completed notification after a dialog
    // includes the time the dialog was open — the run clock never pauses.
    // The clock advances while the dialog is actually open (the dialog
    // notification went out, the confirm answer is still gated), never
    // inside the tool before the dialog exists.
    useTelegramEnv(t, { botToken: 'test-bot-token', chatId: '12345' });
    const stub = installTelegramFetchStub();
    t.after(() => stub.restore());
    const clock: TestClock = { now: 1_700_000_000_000 };
    t.mock.method(Date, 'now', () => clock.now);
    const cwd = makeTempRoot('dialog-duration');
    let releaseConfirm!: () => void;
    const confirmReleased = new Promise<void>((resolve) => {
      releaseConfirm = () => resolve();
    });
    const slowConfirmToolFactory: InlineExtension = async (pi: ExtensionAPI) => {
      pi.registerTool({
        name: 'ask_slow',
        label: 'Ask slow',
        description: 'Opens a dialog the developer takes a minute to answer.',
        parameters: Type.Object({}),
        execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
          await ctx.ui.confirm('Proceed?', 'Ship it?');
          return {
            content: [{ type: 'text', text: 'noted' }],
            details: undefined,
          };
        },
      });
    };
    const scripts: ScriptedReply[] = [
      { kind: 'tool', name: 'ask_slow', text: 'Need a yes.', tickMs: 1_000 },
      { kind: 'text', text: 'Finished.', tickMs: 1_000 },
    ];
    const { session, sessionManager } = await createScriptedSession({
      scripts,
      cwd,
      clock,
      extensionFactories: [slowConfirmToolFactory],
      holdConfirm: {
        releaseConfirm: () => confirmReleased,
      },
    });
    t.after(async () => shutdownSession(session));

    const promptDone = session.prompt('ship it');
    // The dialog notification went out, so the dialog is open: the clock
    // moves now, while the developer is still reading.
    await stub.waitForRequests(1);
    clock.now += 65_000;
    releaseConfirm();
    await promptDone;
    const requests: RecordedTelegramRequest[] = await stub.waitForRequests(2);
    assert.equal(requests.length, 2);

    const tag = sessionManager.getSessionId().slice(-4);
    const dialogText = String(requests[0].body['text']);
    assert.ok(dialogText.startsWith(`❓ <b>Waiting for you</b> · #s${tag}\n`));
    assert.equal(
      requests[1].body['text'],
      `✅ <b>Completed</b> · 1m 07s · #s${tag}\n` +
        `${path.basename(cwd)}\n` +
        `\n` +
        `<blockquote expandable>Finished.</blockquote>`,
    );
  });
});
