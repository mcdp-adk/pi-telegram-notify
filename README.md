# pi-telegram-notify

A pi extension that sends you a Telegram message whenever pi stops and waits
on you in a terminal UI (`tui`) session, so you can leave the computer and
come back the moment it needs you.

Three moments notify, each as one Telegram message that rings:

- `✅ Completed · <duration> · #s<tag>` when a run finishes, with the end of
  pi's final reply in a collapsed quote below.
- `❌ Error · <duration> · #s<tag>` when a run fails, with the error message
  in bold above the quote.
- `❓ Waiting for you · #s<tag>` when a run opens a dialog (a confirm, a
  choice, an input), with the dialog title in bold — no duration, the run
  is still going — and the reply so far, if any, in the quote.

Every message names the project (the basename of the session's working
directory) and the session name when the session has one; the `#s<tag>`
tells apart sessions in the same project. Quotes hold about 800 characters
of the reply, the bold error line about 300. A run that lasts less than a
minute stays silent, and so does a dialog opened that early in a run — a
quick run finishes before you could have left the computer. Anything
else — an aborted run, a dialog opened outside a run, a non-`tui` session
(`pi -p`, `--mode json`, `--mode rpc`), session start and end — stays
silent. Sends run in the
background and never delay, abort, or crash the session.

## Create the bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow its questions: a display name, then a username
   ending in `bot` (for example `my_pi_notifier_bot`).
3. BotFather replies with the bot token, a string like
   `<bot-id>:<secret>`, such as `123456789:AA…`. Keep it secret — anyone
   holding it controls the bot. See
   [BotFather](https://core.telegram.org/bots/features#botfather) and
   [Bots: An introduction for developers](https://core.telegram.org/bots).

If the token ever leaks, send `/token` to BotFather to revoke it and get a
new one.

## Find the chat id

The chat id tells the bot where to post: your numeric user id for a private
chat, a negative id (usually starting with `-100`) for a group or channel, or
a channel's public `@username`.

1. Add the bot to the target chat, or open a private chat with it.
2. Send any message there (for example `/start`).
3. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser.
4. Look for `"chat":{"id":…}` in the JSON reply. That number is the chat id.

`getUpdates` only returns recent updates (see the
[Bot API](https://core.telegram.org/bots/api#getupdates)). If the reply is
empty, send another message first, and remove any webhook with
`/deleteWebhook` while you look the id up. Alternatively, messaging
`@userinfobot` in Telegram replies with your own numeric id.

## Let the bot reach the chat

Bots cannot start a conversation on their own: as
[core.telegram.org](https://core.telegram.org/bots) puts it, a user must
either add them to a group or send them a message first.

- Private chat: open the bot and press Start (send `/start`) before leaving
  pi.
- Group: add the bot to the group.
- Channel: add the bot and give it permission to post.

Until then, sends fail — typically with `Forbidden: bot can't initiate
conversation with a user` for a private chat the bot has never been messaged
in, or `Bad Request: chat not found` for an unknown chat id.

## Install

Install the extension from npm:

```bash
pi install npm:@mcdp-adk/pi-telegram-notify
```

Or install it from this repository, which follows `main` instead of
releases:

```bash
pi install git:github.com/mcdp-adk/pi-telegram-notify
```

`pi list` shows the installed packages. Then restart pi (or reload
extensions) and start a session. To try it once without installing:

```bash
pi -e npm:@mcdp-adk/pi-telegram-notify
```

## Configure

Configuration comes only from the environment — no flag, command, or
settings file:

| Variable | Holds | Required |
| --- | --- | --- |
| `PI_TELEGRAM_NOTIFY_BOT_TOKEN` | The bot token from BotFather | Yes |
| `PI_TELEGRAM_NOTIFY_CHAT_ID` | The recipient chat id (numeric, or `@channelusername`) | Yes |
| `PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS` | Minimum run age in seconds before a notification may go out (`0` notifies always) | No (default `60`) |

Export both before starting pi:

```bash
export PI_TELEGRAM_NOTIFY_BOT_TOKEN='<your-bot-token>'
export PI_TELEGRAM_NOTIFY_CHAT_ID='<your-chat-id>'
```

At session start in a `tui` session, each missing (unset or empty) variable
produces one warning naming it, for example
`pi-telegram-notify: PI_TELEGRAM_NOTIFY_BOT_TOKEN is not set; Telegram
notifications are disabled for this session.` The session then sends nothing.
Sessions in any other mode never warn. Short runs stay silent too: a run —
or a dialog within it — younger than `PI_TELEGRAM_NOTIFY_MIN_RUN_SECONDS`
seconds sends nothing, since a quick run finishes before you could have left
the computer. The default is 60 seconds and `0` notifies always. An invalid
value (anything non-numeric or negative) warns once at session start and
behaves as the default. The token and chat id are not checked at startup: a
wrong token or chat id shows up only as a failed send. A failed send warns
in pi with Telegram's reason, for example `pi-telegram-notify: failed to
send notification: Unauthorized`. Only the first failure in a row warns
until a send succeeds again, and a failed send is never retried. When
nothing arrives, check both values first (`Unauthorized` means the token is
wrong, `Bad Request: chat not found` means the chat id is).

## Proxy

Sends use the global `fetch` with no proxy setting of their own, so they
follow whatever proxy pi already uses: its `httpProxy` setting, or
`HTTPS_PROXY` and `NO_PROXY` from the environment. Configure the proxy once
for pi and notifications inherit it.

## First notification

1. Set both variables and start pi in a terminal.
2. No warning at session start means the extension is armed.
3. Start any run and walk away. When it completes, your phone rings with the
   `✅ Completed` message.
