// Telegram sender: posts one rendered text as a new message that rings
// (no `disable_notification`), with link previews off. Fire-and-forget: the
// send promise is never returned and every failure is swallowed here, so a
// send can never delay, abort, or crash the session. Later tickets report
// failures; this one only guarantees they stay silent.
export function sendTelegramMessage(botToken: string, chatId: string, text: string): void {
  try {
    void fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
    }).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    // A synchronously-throwing fetch (no network stack, invalid URL) must
    // not reach pi either.
  }
}
