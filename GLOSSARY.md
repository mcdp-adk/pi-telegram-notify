# pi-telegram-notify

A pi extension that sends Telegram notifications so the developer can follow pi's progress away from the computer.

## Language

**Session**:
One pi conversation, from starting pi or `/new` until leaving it; the developer may run several at once in different projects.

**Project name**:
The basename of a session's working directory, as pi shows it in the terminal title.
_Avoid_: repo name, workspace

**Session name**:
The display name pi stores for a session, set by `/name` or `--name`; a session may have none.
_Avoid_: session title

**Session tag**:
The last four hex characters of a session's id, shown on every notification to tell sessions apart.
_Avoid_: session label, short id

**Run**:
Everything pi does in a session between receiving a message and stopping to wait for the next one; it ends completed, with an error, or aborted.
_Avoid_: Turn (one model reply within a run), task

**Dialog**:
A blocking prompt an extension shows the developer through pi's UI (a choice, confirmation, text input, editor, or custom component); the run waits until the developer answers it.
_Avoid_: UI prompt, question

**Notification**:
One Telegram message the extension sends about a session.

**Notification level**:
The setting that decides which moments in a run produce notifications and how much each says; each level includes everything below it.
_Avoid_: Verbosity, mode

**Progress message**:
The one notification level 3 sends silently at the start of a run and keeps editing in place until the run ends.
_Avoid_: status message, live message

**Sub-agent**:
A separate pi process another extension starts to carry out a task for a session.
_Avoid_: Child, delegate
