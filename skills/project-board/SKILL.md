---
name: project-board
description: Sync a task from the current chat, check a card’s status, or plan the next release step for each project the user selects on their local Project Board.
---

Use the board CLI `board.mjs` in the board repository, two directories above this skill when bundled. If the skill has been installed separately, use the absolute path to the board CLI configured by the user. Use the current assistant's tool for local commands. Pass each argument separately where supported. Preserve the language of the user's task.

1. Use `node board.mjs projects` to find the project. In a portable release, use the Node executable from the board's connection instructions or the bundled `runtime/node` (`runtime/node.exe` on Windows). Use the conversation’s project when known. If there are multiple plausible projects, ask which one.
2. On resuming work or when checking what is missing, read `node board.mjs context --project ID --provider NAME --session CHAT_ID`. Use a stable provider name and the conversation identifier supplied by the client. If a client exposes no chat ID, establish a stable thread label with the user. With a Codex chat use provider `codex` and the real thread ID. To check for work already captured elsewhere in the project, omit both provider and session. Compare the user's intent with current cards and pending or dismissed proposals. Use the board's current status and next step when they change the work being discussed.
3. For an explicit request to put work on the board, run `node board.mjs add --project ID --provider NAME --session CHAT_ID --event ITEM_ID "Title"`. A concrete future deliverable inferred from a request or identified in a final answer can use `suggest` in place of `add`. Reuse the same event ID on retries. For multiple independent deliverables, append a stable suffix per deliverable. If the client supplies no event ID, omit the flag and keep the title stable on retry.
4. Sync at the end of a relevant turn or on an explicit request. Skip acknowledgements, brainstorms, completed work and instructions already covered by a card or by a dismissed proposal. When the user explicitly requests a previously dismissed task, use the new instruction's event ID.
5. Check the returned decision and card number before reporting a task as added. A pending suggestion awaits a decision on the board. A card with `deleted: true` can be restored from the board’s trash.

Respect future `snoozedUntil` and `projectSnoozedUntil` dates when suggesting what to do now. Dates follow the board's Moscow calendar. When progress actually requires the user's answer, send `ask --project ID --provider NAME --session CHAT_ID --event QUESTION_ID "Question"`. Use `answered` with the same source and question ID once answered or withdrawn. A new question needs a fresh event ID. Both commands use the same board CLI and port as task commands.

## When the user wants to release several projects

Resolve the projects named in the request against `projects`. Browser filters are local to the browser; the CLI needs explicit project IDs. For each selected project, read its full `context --project ID`, including unfinished cards, blockers, and previous decisions. Use relevant release notes, tests or chat evidence available to you to identify what still prevents the release. If the evidence is insufficient, ask a specific question about that project and continue with the others.

When adding or suggesting a task, pass `--description "…"` with task-specific context, constraints, or acceptance criteria that the conversation actually states. Use the user's language. Leave it empty when the conversation gives only a title.

Choose one action per project when requested. Prefer an existing open card that already covers it. For a new card, name a concrete deliverable and pass `--next "First action and an observable completion criterion"` to `add`, or to `suggest` if the user wants to review first. Keep the event ID stable per requested item on retries. Check each receipt and report the project, card number, and how to tell it is done. On a later review, re-read the context and verify the outcome before choosing the next blocker. Assess the release itself against the project's release criteria.
