// Telegram sender: posts one rendered text as a new message that rings
// (no `disable_notification`), with link previews off. Fire-and-forget: the
// send promise is never returned and no failure path throws, so a send can
// never delay, abort, or crash the session.
//
// A failure warns through the `onFailure` callback the extension passes,
// which warns through the latest event's context. Only the first failure in
// a row warns; a successful send re-arms the warning. A failed send is never
// retried.
let failureWarned = false;

// A network error warns with the error's own message and its `cause`, since
// `fetch` reports `fetch failed` and puts the real reason in `cause`.
function networkCause(error: unknown): string {
  if (error instanceof Error) {
    if (error.cause === undefined || error.cause === null || error.cause === '') {
      return error.message;
    }
    const causeText = error.cause instanceof Error ? error.cause.message : String(error.cause);
    return `${error.message}: ${causeText}`;
  }
  return String(error);
}

// Classifies a settled send: `undefined` when Telegram accepted it, else the
// real cause for the warning. Anything that is not the Bot API's JSON
// envelope — an unparseable body, or JSON without a boolean `ok` — is
// malformed, reported with its HTTP status. An `ok: false` envelope warns
// with Telegram's `description` verbatim.
async function failureCause(response: Response): Promise<string | undefined> {
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch (error) {
    // A body that fails mid-read is a transport failure, not a malformed
    // envelope: only unparseable JSON names the body. Anything else warns
    // with its own message and cause, like a network error.
    if (error instanceof SyntaxError) {
      return `malformed response (HTTP ${response.status})`;
    }
    return networkCause(error);
  }
  if (typeof envelope !== 'object' || envelope === null) {
    return `malformed response (HTTP ${response.status})`;
  }
  const record = envelope as { ok?: unknown; description?: unknown };
  if (typeof record.ok !== 'boolean') {
    return `malformed response (HTTP ${response.status})`;
  }
  if (record.ok) {
    return undefined;
  }
  if (typeof record.description !== 'string') {
    return `malformed response (HTTP ${response.status})`;
  }
  return record.description;
}

export function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  onFailure: (cause: string) => void,
): void {
  const reportOnce = (cause: string): void => {
    if (failureWarned) {
      return;
    }
    failureWarned = true;
    try {
      onFailure(cause);
    } catch {
      // The warning itself must never disturb the session.
    }
  };
  let pending: Promise<Response>;
  try {
    pending = fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
    });
  } catch (error) {
    // A synchronously-throwing fetch warns like a network error, still
    // without disturbing the session.
    reportOnce(networkCause(error));
    return;
  }
  void pending.then(
    (response) => {
      void failureCause(response).then(
        (cause) => {
          if (cause === undefined) {
            failureWarned = false;
          } else {
            reportOnce(cause);
          }
        },
        () => {
          reportOnce(`malformed response (HTTP ${response.status})`);
        },
      );
    },
    (error: unknown) => {
      reportOnce(networkCause(error));
    },
  );
}
