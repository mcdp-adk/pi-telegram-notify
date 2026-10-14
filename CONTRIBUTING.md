# Contributing

How work moves from issue to PR here, for whoever writes an issue, a commit, a PR, or a comment. The skills write specs, tickets, and PR bodies; this file states only what this project adds to them.

## Issues

An issue follows the `to-spec` and `to-tickets` templates. This project adds:

- **Triage labels.** The five state labels live in `docs/agents/triage-labels.md`, which also maps the `bug` and `enhancement` category labels.

## Commits

Conventional Commits:

- **Title only.** No scope and no body. *checked: commitlint*
- **One intention per commit.** The title describes the whole change.

## Pull requests

- Changes reach `main` through a PR unless the owner asks for a direct commit.
- **Title.** A PR title follows the commit rules, since a squash merge makes it a commit on `main`. *checked: conventions*
- **Body.** The template at `.github/pull_request_template.md` gives the body its shape: the closing line — `Closes #N` when the PR finishes the issue, `Refs #N` when it does not — then `Summary`, `Evidence`, and `Merge Danger`. How to write each section is the `pr` skill's to teach. *checked: conventions*
- **Checks.** The `conventions` workflow checks every rule marked *checked: conventions*. A rule about an issue is checked for each issue a PR closes, once the PR is ready, and a failure names what to fix.
- **Stacked PRs.** A rebase or squash merge gives a PR's commits new hashes, so a PR built on it still carries the old ones and conflicts with `main`; once the base PR merges, move the stacked PR's own commits with `git rebase --onto origin/main <old base tip>`.

## Acceptance criteria

Acceptance criteria are optional: an issue lists them when the owner wants a checklist of what done means. When it does:

- Only the owner rewords an acceptance criterion; an agent proposes the new wording in conversation.
- Every ticked acceptance criterion has evidence.
- An issue closes only with every criterion ticked. *checked: conventions*

## Evidence

- Evidence separates what was observed from its suspected cause, and marks a cause not reproduced as a hypothesis.
- Evidence cites commits reachable from the PR or `main`, and states its results on GitHub. A history rewrite drops commits from both, so evidence citing them is updated. *checked: conventions*
