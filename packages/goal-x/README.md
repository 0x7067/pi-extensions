# @fractaal/pi-goal-x

Goal is maintained alongside two independent sibling Pi extensions:

- **`@fractaal/pi-goal-x`** - one branch-local Goal with confirmed proposal/tweak, relentless autonomous continuation, strict model-owned blocking, native human pause/resume, abandonment, independent completion audit, final prose settlement, replay, a native widget, and structured events.
- **`@fractaal/pi-todo`** in [`packages/todo`](../todo) — one revisioned branch-local working plan with omission protection, dependency validation, context salience, replay, a native widget, and structured state.

- **`@fractaal/pi-context-window`** in [`packages/context-window`](../context-window) — per-session and per-model context-window budgets.

They have no runtime dependency on each other and do not import Symphony, Aria, ALR, IPC, RTDB, Gateway, React, or product-specific types.

## Goal

Model tools:

- `propose_goal({ objective })`
- `tweak_goal({ objective })`
- `set_goal_blocked({ blocker, evidence, whyNoAutonomousPathRemains, unblockCondition })`
- `wait_goal({ delaySeconds, waitingFor })`
- `resume_goal()`
- `abandon_goal({ reason })`
- `complete_goal({ summary })`

Events:

- `pi-goal:state` — complete `GoalState` snapshot
- `pi-goal:proposal` — complete current proposal snapshot
- `pi-goal:transcript-event` — bounded lifecycle receipt
- `pi-goal:request-state` — asks the producer to replay current state and proposal

Goal state lives only in Pi session custom entries. It is replayed on session start, tree navigation, and compaction. Autonomous continuation appends one constant durable message after each normal settled run while the Goal remains active: `Continue the Goal.` wrapped in a `<system_message source="goal_extension">` tag stating that it is an automatic reprompt, not a message, answer, approval, or permission from the user. Pi delivers custom messages in the user role, so the label, together with a matching line in the Goal system-prompt block, keeps the model from reading a continuation as the user's reply. Confirming a Goal, resuming it, or confirming a revision of it starts continuation; a confirmed revision therefore also resumes a blocked or paused Goal. The model can delay the next continuation by one minute to one hour with `wait_goal`, including while a decision it put to the user is unanswered, which keeps the Goal active, emits `goal_waiting`, and is preempted by any earlier run. The model can stop continuation only by making the fully evidenced `set_goal_blocked` claim. That transition emits `goal_blocked` and maps into the existing internal `paused` state by encoding the complete proof in the compatible `pause.reason` and `pause.suggestedAction` fields. The native `/goal-pause` command remains a genuine human pause and emits `goal_paused`. At the start of each run, Goal adds one deterministic semantic block to Pi's system prompt; accounting revisions, timestamps, usage, and active-time changes do not alter those prompt bytes. Pi core owns provider retry and compaction recovery. The completion auditor receives an OS-sandboxed read-only shell when Bubblewrap is available; on platforms without that boundary, it receives only Pi's read/grep/find/ls tools.

## Todo

`get_todo()` reads the exact current revision and task list without mutation. The `todo` tool replaces the complete retained plan:

```ts
todo({
  baseRevision: 3,
  tasks: [
    { key: "implement", subject: "Implement the bridge", status: "in_progress" },
    { key: "verify", subject: "Verify it", status: "pending", dependsOn: ["implement"] }
  ],
  remove: []
})
```

An existing unfinished task cannot disappear unless `remove` names its key and gives a non-empty reason. Completed work may leave the current working plan. Stale revisions, normalized dependency collisions, invalid dependency graphs, and plans above the 16 KiB serialized UTF-8 budget leave state unchanged.

Todo contents are never floated into every provider request. Pi's stable system instructions tell the model when to use `get_todo`. When unfinished state becomes distant in context, after restoration, or after compaction, Todo queues one hidden durable checkpoint into an already-required provider call or the next external turn. Checkpoints never wake an idle model by themselves and stop when no unfinished work remains.

Events:

- `pi-todo:state` — complete `TodoState` snapshot
- `pi-todo:request-state` — asks the producer to replay current state

## Development

Run from the monorepo root:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run test:installed
```

The shared Goal/Todo/context-window Node tests and installed-package acceptance live in this package's `tests/` directory. Root commands invoke them explicitly, separately from Vitest. Acceptance packs all three sibling packages and installs each alone under temporary Pi profiles, exercising public exports, RPC discovery/replay, deterministic Goal continuation and audit settlement, Todo idempotence, and context-window lifecycle/compaction behavior. It makes no real model calls and never uses the normal Personal Pi profile.

## Releases and source

Use the [monorepo release guide](https://github.com/fractaal/pi-extensions/blob/main/docs/releasing.md). Goal, Todo, and context-window keep independent versions and tags (`goal-x-v<version>`, `todo-v<version>`, `context-window-v<version>`); a batch can release all of them from one accepted commit. npm must authorize `fractaal/pi-extensions`, workflow filename `publish-npm.yml`, environment `npm-publish` for each package. Do not publish locally.

Goal 0.28.9, Todo 0.1.3, and context-window 0.1.1 relocate the source without changing their runtime implementation or public exports. The reviewed source snapshot is `fractaal/pi-goal-x@f74698d6a0eb9f78ff80e7adb01c6a9070010804`, corresponding to published Goal 0.28.8, Todo 0.1.2, and context-window 0.1.0. Private Git history was not imported. Original MIT licenses and upstream attribution are retained.
