// PROTOTYPE, throwaway: answers "What a notification message looks like" (issue #7).
// Sends sample notifications in three structurally different variants to a real chat.
//
//   node send.ts --dry-run        print every payload instead of sending
//   node send.ts [A|B|C] [...]    send the chosen variants (default: all)
//
// Credentials: TG_TOKEN and TG_CHAT in the environment or in .env next to this file.

import { existsSync } from 'node:fs';

const envFile = new URL('.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

type Moment = 'completed' | 'error' | 'dialog' | 'aborted' | 'started';

interface Sample {
  label: string;
  level: 1 | 2 | 3;
  moment: Moment;
  project: string;
  sessionName?: string;
  tag: string;
  detail?: string; // error message or dialog title
  duration?: string; // level 2+
  reply?: string; // last reply, level 2+
}

const longReply = `I traced the duplicate notifications to \`agent_settled\` firing once per injected sub-agent result, not once per run. Each async completion wakes the parent session, which runs a short turn and settles again, so a run with three background delegates produced four messages. That matches what the issue on sub-agent detection predicted, and the owner already accepted the cost, so I left the trigger alone and only fixed the formatting bug that started this.

The formatting bug itself: a reply containing \`a < b && c > d\` reached Telegram unescaped and the API answered "Bad Request: can't parse entities". Escaping now happens once, at the edge, right before the text is wrapped in tags.

Done. The prototype now sends every sample through \`sendMessage\` with \`parse_mode=HTML\`.

**What changed**
- \`src/extension.ts\`: registers \`agent_settled\` and \`ui_prompt_start\`
- \`src/format.ts\`: escapes \`<\`, \`>\` and \`&\` before building the message
- \`test/format.test.ts\`: 14 cases, including a 6000-character reply

\`\`\`ts
if (text.length > LIMIT) text = text.slice(0, LIMIT - 1) + '…';
\`\`\`

**Checks**
- \`npm run lint\`: clean
- \`npm test\`: 14 passed

One open point: the excerpt keeps the end of the reply, since pi usually closes with a summary. If you'd rather see the start, say so and I'll flip it.`;

const named = { project: 'pi-telegram-notify', sessionName: 'message look', tag: '0248' };
const unnamed = { project: 'auth-refactor', tag: 'b7e1' };

const samples: Sample[] = [
  { label: 'L1 completed', level: 1, moment: 'completed', ...named },
  { label: 'L2 completed', level: 2, moment: 'completed', ...named, duration: '12m 34s', reply: longReply },
  {
    label: 'L2 error',
    level: 2,
    moment: 'error',
    ...unnamed,
    detail: '429 rate_limit_error: This request would exceed the rate limit for your organization of 40,000 input tokens per minute.',
    duration: '3m 05s',
    reply: 'Reading `src/auth/session.ts` to find where the token <refresh> happens…',
  },
  { label: 'L2 dialog', level: 2, moment: 'dialog', ...named, detail: 'Allow bash: rm -rf .worktrees/old-topic?', duration: '41s' },
  { label: 'L3 aborted', level: 3, moment: 'aborted', ...unnamed, duration: '1m 12s' },
  { label: 'L3 started', level: 3, moment: 'started', ...named },
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const head = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…');
const tail = (s: string, n: number) => (s.length <= n ? s : '…' + s.slice(s.length - n + 1).trimStart());

// Rough Markdown → Telegram HTML: code fences, inline code, bold. Enough to judge the look.
function mdToHtml(md: string): string {
  return md
    .split(/```[a-z]*\n?/)
    .map((part, i) =>
      i % 2 === 1
        ? `<pre>${esc(part.trimEnd())}</pre>`
        : esc(part)
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
            .replace(/^- /gm, '• '),
    )
    .join('');
}

const icon: Record<Moment, string> = { completed: '✅', error: '❌', dialog: '❓', aborted: '⏹', started: '▶️' };
const verb: Record<Moment, string> = {
  completed: 'Completed',
  error: 'Error',
  dialog: 'Waiting for you',
  aborted: 'Aborted',
  started: 'Started',
};

// A: status headline, identity line with a clickable hashtag, excerpt (tail) folded in an expandable quote.
function variantA(s: Sample): string {
  const lines = [`${icon[s.moment]} <b>${verb[s.moment]}</b>${s.duration ? ` · ${s.duration}` : ''}`];
  lines.push(`${esc(s.project)}${s.sessionName ? ` · ${esc(s.sessionName)}` : ''} · #s${s.tag}`);
  if (s.detail) lines.push('', `<b>${esc(s.detail)}</b>`);
  if (s.reply) lines.push('', `<blockquote expandable>${esc(tail(s.reply, 800))}</blockquote>`);
  return lines.join('\n');
}

// B: identity first, tag as tap-to-copy code, excerpt (head) rendered from Markdown, no quote.
function variantB(s: Sample): string {
  const lines = [`<b>${esc(s.project)}</b>${s.sessionName ? ` / ${esc(s.sessionName)}` : ''}  <code>${s.tag}</code>`];
  lines.push(`${icon[s.moment]} ${verb[s.moment]}${s.duration ? ` · ${s.duration}` : ''}${s.detail ? `\n${esc(s.detail)}` : ''}`);
  if (s.reply) lines.push('', mdToHtml(head(s.reply, 1200)));
  return lines.join('\n');
}

// C: one plain sentence, excerpt (short tail) as raw text in a code block.
function variantC(s: Sample): string {
  const who = `${esc(s.project)}${s.sessionName ? ` (${esc(s.sessionName)})` : ''} [${s.tag}]`;
  let line = `${icon[s.moment]} ${who} ${verb[s.moment].toLowerCase()}`;
  if (s.duration) line += ` after ${s.duration}`;
  if (s.detail) line += `: ${esc(s.detail)}`;
  return s.reply ? `${line}\n<pre>${esc(tail(s.reply, 300))}</pre>` : line;
}

const variants = { A: variantA, B: variantB, C: variantC } as const;
type Key = keyof typeof variants;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const chosen = (args.filter((a) => a in variants) as Key[]).sort();
const keys: Key[] = chosen.length ? chosen : ['A', 'B', 'C'];

const token = process.env.TG_TOKEN;
const chat = process.env.TG_CHAT;
if (!dryRun && (!token || !chat)) throw new Error('Set TG_TOKEN and TG_CHAT, in the environment or in .env');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(text: string, silent = false): Promise<void> {
  if (dryRun) {
    console.log(`${silent ? '[silent] ' : ''}${text}\n${'-'.repeat(60)}`);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chat,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      disable_notification: silent,
    }),
  });
  const body = (await res.json()) as { ok: boolean; description?: string };
  if (!body.ok) throw new Error(`${res.status} ${body.description}\n${text}`);
  await sleep(1100);
}

for (const key of keys) {
  await send(`━━━━━━ <b>Variant ${key}</b> ━━━━━━`, true);
  for (const s of samples) {
    if (dryRun) console.log(`# ${key} ${s.label}`);
    await send(variants[key](s), s.moment === 'started');
  }
}
console.log(dryRun ? 'dry run done' : `sent variants ${keys.join(', ')}`);
