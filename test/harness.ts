// Test harness for this package's suites: a real pi SDK session that loads
// the package through package discovery, with the model boundary scripted by
// a faux provider and Telegram replaced at `globalThis.fetch`. The scripted
// replies cover text, tool-call, and error shapes for the suites below.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  JsonObject,
  Model,
  ToolCall,
} from '@earendil-works/pi-ai';
import {
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentSession,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  ExtensionAPI,
  ExtensionUIContext,
  InlineExtension,
} from '@earendil-works/pi-coding-agent';
// AuthStorage is not re-exported from the package index, so the harness
// reaches the same module pi itself loads, by the path that exists at
// runtime — never `any`, and never through the package under test.
import { AuthStorage } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js';
import { Type } from 'typebox';

const MODEL: Model<Api> = {
  id: 'faux-1',
  name: 'Faux 1',
  api: 'faux-s',
  provider: 'faux',
  baseUrl: 'http://localhost:0',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
  reasoning: false,
};

const MSG_BASE = (): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: 'faux-s',
  provider: 'faux',
  model: 'faux-1',
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: Date.now(),
});

// A clock the test owns: the suite mocks `Date.now` to read it, and a
// scripted step advances it while the run is in progress, so durations are
// exact without waiting.
export interface TestClock {
  now: number;
}

// Scripted model replies, consumed in order per prompt turn. `tickMs`
// advances the test clock when the step is consumed.
export type ScriptedReply =
  | { kind: 'text'; text: string; tickMs?: number; done?: 'stop' | 'length' }
  | { kind: 'tool'; name: string; args?: JsonObject; text?: string; tickMs?: number }
  | { kind: 'error'; text?: string; errorMessage: string; tickMs?: number };

function pushScripted(stream: AssistantMessageEventStream, next: ScriptedReply): AssistantMessage {
  let msg: AssistantMessage;
  if (next.kind === 'tool') {
    const tc: ToolCall = {
      type: 'toolCall',
      id: `tc-${Math.random().toString(36).slice(2, 8)}`,
      name: next.name,
      arguments: next.args ?? {},
    };
    msg = {
      ...MSG_BASE(),
      content: [{ type: 'text', text: next.text ?? 'calling tool' }, tc],
      stopReason: 'toolUse',
    };
    stream.push({ type: 'start', partial: msg });
    stream.push({ type: 'toolcall_start', contentIndex: 1, partial: msg });
    stream.push({ type: 'toolcall_end', contentIndex: 1, toolCall: tc, partial: msg });
    stream.push({ type: 'done', reason: 'toolUse', message: msg });
  } else if (next.kind === 'error') {
    msg = {
      ...MSG_BASE(),
      content: next.text === undefined ? [] : [{ type: 'text', text: next.text }],
      stopReason: 'error',
      errorMessage: next.errorMessage,
    };
    stream.push({ type: 'start', partial: msg });
    if (next.text !== undefined) {
      stream.push({ type: 'text_delta', contentIndex: 0, delta: next.text, partial: msg });
    }
    stream.push({ type: 'error', reason: 'error', error: msg });
  } else {
    const done = next.done ?? 'stop';
    msg = { ...MSG_BASE(), content: [{ type: 'text', text: next.text }], stopReason: done };
    stream.push({ type: 'start', partial: msg });
    stream.push({ type: 'text_delta', contentIndex: 0, delta: next.text, partial: msg });
    stream.push({ type: 'done', reason: done, message: msg });
  }
  return msg;
}

export interface RecordedNotification {
  message: string;
  level: string | undefined;
}

export interface ScriptedSessionOptions {
  scripts: ScriptedReply[];
  cwd: string;
  // The mode `bindExtensions` accepts; named from its parameter because the
  // package index does not re-export the mode union.
  mode?: NonNullable<Parameters<AgentSession['bindExtensions']>[0]['mode']>;
  clock?: TestClock;
  // Extra inline factories beside the faux provider, e.g. a suite's tools
  // that open dialogs or fail on purpose.
  extensionFactories?: InlineExtension[];
  // A suite that must hold a scripted dialog open (e.g. to advance the
  // clock mid-dialog) passes a gate: `confirm` waits for
  // `releaseConfirm()` before answering. The suite observes the open
  // dialog through the notification the open dialog sends.
  holdConfirm?: {
    releaseConfirm: () => Promise<void>;
  };
  // Extra package directories loaded before this package, so their
  // extensions observe events first. The foreign-dialog suite needs an
  // extension ordered ahead of the package under test.
  earlierPackages?: string[];
}

export interface ScriptedSession {
  session: AgentSession;
  sessionManager: SessionManager;
  notifications: RecordedNotification[];
}

// A pi session whose provider scripts the given replies in order. The package
// under test loads the way pi loads packages (package discovery on the
// package.json pi manifest) — never by importing src/extension.ts directly.
export async function createScriptedSession({
  scripts,
  cwd,
  mode = 'tui',
  clock,
  extensionFactories = [],
  holdConfirm,
  earlierPackages = [],
}: ScriptedSessionOptions): Promise<ScriptedSession> {
  const remaining: ScriptedReply[] = [...scripts];
  const notifications: RecordedNotification[] = [];
  const streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    const next: ScriptedReply = remaining.shift() ?? { kind: 'text', text: 'done' };
    queueMicrotask(() => {
      if (clock !== undefined && next.tickMs !== undefined) {
        clock.now += next.tickMs;
      }
      const msg = pushScripted(stream, next);
      stream.end(msg);
    });
    return stream;
  };
  const packageExtensionFactory = async (pi: ExtensionAPI) => {
    pi.registerProvider('faux', {
      api: 'faux-s',
      apiKey: 'test-key',
      models: [MODEL],
      streamSimple,
    });
  };
  const repoRoot = path.resolve(import.meta.dirname, '..');
  // SettingsManager.inMemory({ packages: [...] }) writes the packages list into
  // InMemorySettingsStorage under scope "global"; PackageManager reads the merged
  // settings to find the package sources. Do NOT wrap in { globalSettings: {...} }.
  const settingsManager = SettingsManager.inMemory({ packages: [...earlierPackages, repoRoot] });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    extensionFactories: [packageExtensionFactory, ...extensionFactories],
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'You are a test bot.',
  });
  await loader.reload();

  const sessionManager = SessionManager.inMemory(cwd);
  const result = await createAgentSession({
    cwd,
    agentDir: cwd,
    settingsManager: SettingsManager.inMemory({}),
    resourceLoader: loader,
    sessionManager,
    model: MODEL,
    // In-memory credentials: the file-backed defaults lazily write auth.json
    // into agentDir (= cwd), recreating the directory after its test removed it.
    modelRuntime: await ModelRuntime.create({ modelsPath: null, credentials: AuthStorage.inMemory() }),
  });
  const session = result.session ?? result;
  // The headless suite observes notices through the injected ui surface, like
  // pi's CLI does. Only the dialogs the suites observe are implemented, so the
  // partial surface is asserted to pi's ui context type instead of faking the
  // whole CLI.
  await session.bindExtensions({
    mode,
    uiContext: {
      notify: (message: string, level?: 'info' | 'warning' | 'error') => {
        notifications.push({ message, level });
      },
      select: async () => undefined,
      confirm: async () => {
        if (holdConfirm !== undefined) {
          await holdConfirm.releaseConfirm();
        }
        return false;
      },
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => undefined,
    } as unknown as ExtensionUIContext,
  });

  return { session, sessionManager, notifications };
}

export interface ScriptedRuntime {
  runtime: AgentSessionRuntime;
  notifications: RecordedNotification[];
}

// A pi runtime whose sessions load the package the way pi loads packages
// (package discovery on the package.json pi manifest) — never by importing
// src/extension.ts directly. The faux provider's remaining scripts and the
// recorded notifications are shared across the runtime's sessions, so a
// suite can prompt, replace the session through pi's real path, and prompt
// again: `runtime.newSession()` in the same cwd tears the old runtime down
// (`session_shutdown`), creates a new runtime, and invokes the extension
// factory again, while the module cache for the cwd stays shared. Each
// session binds with the same recording UI, so notices from every session
// land in one list.
export async function createScriptedRuntime({
  scripts,
  cwd,
  mode = 'tui',
  clock,
  extensionFactories = [],
  holdConfirm,
  earlierPackages = [],
}: ScriptedSessionOptions): Promise<ScriptedRuntime> {
  const remaining: ScriptedReply[] = [...scripts];
  const notifications: RecordedNotification[] = [];
  const streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    const next: ScriptedReply = remaining.shift() ?? { kind: 'text', text: 'done' };
    queueMicrotask(() => {
      if (clock !== undefined && next.tickMs !== undefined) {
        clock.now += next.tickMs;
      }
      const msg = pushScripted(stream, next);
      stream.end(msg);
    });
    return stream;
  };
  const packageExtensionFactory = async (pi: ExtensionAPI) => {
    pi.registerProvider('faux', {
      api: 'faux-s',
      apiKey: 'test-key',
      models: [MODEL],
      streamSimple,
    });
  };
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const uiContext = {
    notify: (message: string, level?: 'info' | 'warning' | 'error') => {
      notifications.push({ message, level });
    },
    select: async () => undefined,
    confirm: async () => {
      if (holdConfirm !== undefined) {
        await holdConfirm.releaseConfirm();
      }
      return false;
    },
    input: async () => undefined,
    editor: async () => undefined,
    custom: async () => undefined,
  } as unknown as ExtensionUIContext;
  // In-memory credentials: the file-backed defaults would lazily write
  // auth.json into agentDir (= cwd), recreating the directory after its
  // test removed it.
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, credentials: AuthStorage.inMemory() });
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: runtimeCwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    // SettingsManager.inMemory({ packages: [...] }) writes the packages
    // list into InMemorySettingsStorage under scope "global";
    // PackageManager reads the merged settings to find the package
    // sources. Do NOT wrap in { globalSettings: {...} }.
    const settingsManager = SettingsManager.inMemory({ packages: [...earlierPackages, repoRoot] });
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        extensionFactories: [packageExtensionFactory, ...extensionFactories],
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: 'You are a test bot.',
      },
    });
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: MODEL,
    });
    return { ...created, services, diagnostics: services.diagnostics };
  };

  const sessionManager = SessionManager.inMemory(cwd);
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: cwd,
    sessionManager,
  });
  // The headless suite observes notices through the injected ui surface,
  // like pi's CLI does. Binding emits the session start event, so the
  // initial bind starts the first session and each rebind starts its
  // replacement.
  const bind = (session: AgentSession): Promise<void> =>
    session.bindExtensions({ mode, uiContext }).then(() => undefined);
  await bind(runtime.session);
  runtime.setRebindSession(async (session) => {
    await bind(session);
  });

  return { runtime, notifications };
}

// A tool the faux model can call, so a run holds more than one assistant
// message. Its result text must never leak into excerpts or details: only
// assistant text counts.
export const echoToolFactory: InlineExtension = async (pi: ExtensionAPI) => {
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

// Every session ends with `session_shutdown`, so nothing it started outlives
// its test.
export async function shutdownSession(session: AgentSession): Promise<void> {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}

// Ends every session on the runtime: sessions replaced earlier ended with
// `session_shutdown` when pi tore them down, and disposing the runtime
// shuts the current one down the same way.
export async function shutdownRuntime(runtime: AgentSessionRuntime): Promise<void> {
  await runtime.dispose();
}

// Answers the stub gives per Telegram request: a Bot API envelope, a network
// failure, a malformed (non-envelope) response, or a promise that never
// settles. `delayMs` holds a failure back so a send can still be in flight
// when the test moves on (for example to shut the session down). A
// `network-error` carries a `cause` like the real `fetch` does.
export type TelegramAnswer =
  | { kind: 'ok' }
  | { kind: 'bot-error'; description: string; delayMs?: number }
  | { kind: 'network-error'; message: string; cause?: unknown; delayMs?: number }
  | { kind: 'malformed'; status: number; body: string; delayMs?: number }
  // The body fails mid-read, e.g. a socket dying under Telegram's JSON:
  // `response.json()` rejects with this transport error.
  | { kind: 'body-error'; message: string; cause?: unknown }
  | { kind: 'never' };

export interface RecordedTelegramRequest {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

export interface TelegramFetchStub {
  readonly requests: RecordedTelegramRequest[];
  waitForRequests(count: number): Promise<RecordedTelegramRequest[]>;
  // Waits until `count` Telegram fetches settled (answered or failed), so
  // a test can observe a late failure without a fixed delay.
  waitForSettled(count: number): Promise<void>;
  restore(): void;
}

// Replaces `globalThis.fetch` before the session starts. Records each request
// to api.telegram.org and answers from the scripted list (the last answer
// repeats); anything else passes through to the real fetch.
export function installTelegramFetchStub(answer: TelegramAnswer | TelegramAnswer[] = { kind: 'ok' }): TelegramFetchStub {
  const answers = Array.isArray(answer) ? answer : [answer];
  const requests: RecordedTelegramRequest[] = [];
  const realFetch = globalThis.fetch;
  let consumed = 0;
  let settled = 0;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!url.includes('api.telegram.org')) {
      return realFetch(input as string, init);
    }
    // The recorded body narrows from `unknown`: only a non-empty object
    // shape is kept, anything else (a JSON array, a string) records empty.
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(String(init?.body ?? '{}'));
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
        // Narrowed by the shape check above from `unknown`.
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }
    const recorded: RecordedTelegramRequest = { url, method: String(init?.method ?? 'GET'), body };
    requests.push(recorded);
    const next = answers[Math.min(consumed, answers.length - 1)];
    consumed += 1;
    if (next.kind === 'never') {
      return new Promise<Response>(() => {});
    }
    if ((next.kind === 'bot-error' || next.kind === 'network-error' || next.kind === 'malformed') && next.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    }
    // No await follows: every branch below returns or throws in this
    // microtask, so the fetch settles together with this count.
    settled += 1;
    if (next.kind === 'network-error') {
      throw new Error(next.message, { cause: next.cause ?? 'socket hang up' });
    }
    if (next.kind === 'malformed') {
      return new Response(next.body, {
        status: next.status,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (next.kind === 'body-error') {
      const failure = new TypeError(next.message, { cause: next.cause ?? 'socket hang up' });
      return new Response(
        new ReadableStream({ start: (controller) => controller.error(failure) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    const envelope =
      next.kind === 'ok'
        ? { ok: true, result: { message_id: 1, date: 1, text: '' } }
        : { ok: false, error_code: 400, description: next.description };
    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    requests,
    async waitForRequests(count: number): Promise<RecordedTelegramRequest[]> {
      // Polls the recorded requests, never a fixed delay; the attempt cap is
      // only a hang guard. No clock is read, so a mocked `Date.now` cannot
      // disturb the wait.
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        if (requests.length >= count) {
          return requests;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`timed out waiting for ${count} Telegram requests (got ${requests.length})`);
    },
    async waitForSettled(count: number): Promise<void> {
      // Same polling shape as `waitForRequests`: the attempt cap only
      // guards hangs, and no clock is read.
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        if (settled >= count) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`timed out waiting for ${count} settled Telegram requests (got ${settled})`);
    },
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

// Sets the extension's environment for one test and restores it afterwards.
// `undefined` removes the variable, so missing configuration is testable.
// The minimum run duration defaults to `'0'` when the caller leaves it out,
// so the existing suites keep proving the old shapes with no gate in the
// way; pass `minRunSeconds: undefined` explicitly to test the real default.
export function useTelegramEnv(
  t: { after: (fn: () => void) => void },
  vars: { botToken?: string; chatId?: string; minRunSeconds?: string },
): void {
  const prevToken = process.env.PI_TELEGRAM_NOTIFY_BOT_TOKEN;
  const prevChatId = process.env.PI_TELEGRAM_NOTIFY_CHAT_ID;
  const prevMinRunSeconds = process.env.PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS;
  if (vars.botToken === undefined) {
    delete process.env.PI_TELEGRAM_NOTIFY_BOT_TOKEN;
  } else {
    process.env.PI_TELEGRAM_NOTIFY_BOT_TOKEN = vars.botToken;
  }
  if (vars.chatId === undefined) {
    delete process.env.PI_TELEGRAM_NOTIFY_CHAT_ID;
  } else {
    process.env.PI_TELEGRAM_NOTIFY_CHAT_ID = vars.chatId;
  }
  // An absent key (not an explicit `undefined`) means the suite predates the
  // gate: restore the previous always-notify behavior for it.
  if (!('minRunSeconds' in vars)) {
    process.env.PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS = '0';
  } else if (vars.minRunSeconds === undefined) {
    delete process.env.PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS;
  } else {
    process.env.PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS = vars.minRunSeconds;
  }
  t.after(() => {
    if (prevToken === undefined) {
      delete process.env.PI_TELEGRAM_NOTIFY_BOT_TOKEN;
    } else {
      process.env.PI_TELEGRAM_NOTIFY_BOT_TOKEN = prevToken;
    }
    if (prevChatId === undefined) {
      delete process.env.PI_TELEGRAM_NOTIFY_CHAT_ID;
    } else {
      process.env.PI_TELEGRAM_NOTIFY_CHAT_ID = prevChatId;
    }
    if (prevMinRunSeconds === undefined) {
      delete process.env.PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS;
    } else {
      process.env.PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS = prevMinRunSeconds;
    }
  });
}

// Every test directory lives under one per-process root, removed once at
// process exit — not per test.
const TEST_ROOT = path.join(os.tmpdir(), `pi-telegram-notify-test-${process.pid}`);
let exitHookRegistered = false;

export function makeTempRoot(label = 'pi-telegram-notify-test'): string {
  const root = path.join(TEST_ROOT, `${label}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.on('exit', () => {
      fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });
  }
  return root;
}
