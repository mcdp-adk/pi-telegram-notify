# Triage Labels

The `triage` skill speaks in two category roles and five state roles. This file maps each role to the label that carries it in this repo's issue tracker; the labels exist on GitHub.

| Role              | Label             | Meaning                                  |
| ----------------- | ----------------- | ---------------------------------------- |
| `bug`             | `bug`             | Something is broken                      |
| `enhancement`     | `enhancement`     | New feature or improvement               |
| `needs-triage`    | `needs-triage`    | Maintainer needs to evaluate this issue  |
| `needs-info`      | `needs-info`      | Waiting on reporter for more information |
| `ready-for-agent` | `ready-for-agent` | Fully specified, ready for an AFK agent  |
| `ready-for-human` | `ready-for-human` | Requires human implementation            |
| `wontfix`         | `wontfix`         | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the `ready-for-agent` triage label"), use the label string from this table.

Every triaged issue carries exactly one category role and one state role.

