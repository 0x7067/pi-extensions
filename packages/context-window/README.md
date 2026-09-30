# @fractaal/pi-context-window

A portable Pi extension that caps the active model's resolved context window.
Pi still owns reserve tokens, compaction, overflow recovery, and continuation.

Commands:

- `/context-window` shows the current model budget.
- `/context-window 128k` sets the current session override.
- `/context-window max` uses the configured model ceiling.
- `/context-window default` clears the session override.
- `/context-window-default 128k` sets the current model's global default.
- `/context-window-default default` clears that global default.

The session override is persisted in the Pi JSONL. Global defaults are stored
in the same profile directory as `models.json`, using an atomic local JSON file.

## Install and embed

```bash
pi install npm:@fractaal/pi-context-window
```

The package root exports the compiled extension factory; `/contracts` exports the public contracts. Pi discovers the shipped TypeScript entry through `pi.extensions`. These entrypoints and persisted state formats are unchanged by the repository move.

## Opting into a larger provider-supported window

The ceiling is Pi's resolved `contextWindow`, not a separate provider capability
lookup. Some catalogs advertise a conservative default rather than the available
opt-in maximum. For a larger window verified for your account and provider, add
that model's `modelOverrides.contextWindow` in your profile's `models.json`.
For example, on the Codex subscription route where Astra reports an 872K maximum:

```json
{
  "providers": {
    "openai-codex": {
      "modelOverrides": {
        "gpt-6-astra": { "contextWindow": 872000 }
      }
    }
  }
}
```

Merge this into existing configuration; do not replace unrelated providers.
Restart Pi after changing the ceiling. To retain the smaller ordinary budget,
run `/context-window-default 272k`; `/context-window max` then opts this session
into 872K, and `/context-window default` returns to 272K. Larger Codex requests
can consume quota faster. Do not substitute the direct OpenAI API's advertised
window for the Codex subscription limit.

Version 0.1.2 ensures these budget changes reach Pi's active model even when
`models.json` keeps the larger ceiling in the model registry. It does not change
Pi's catalog, automatically discover provider maxima, or alter the state contract.

## Development and releases

Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm run test:installed` from the monorepo root. The shared Node tests and isolated installed-package acceptance live in `packages/goal-x/tests` and are included in those commands.

Use the [shared release guide](https://github.com/fractaal/pi-extensions/blob/main/docs/releasing.md) and tag `context-window-v<version>`. This package has its own version and npm Trusted Publisher, even when released in a batch with its siblings.

Version 0.1.1 imports the unchanged runtime of 0.1.0 from `fractaal/pi-goal-x@f74698d6a0eb9f78ff80e7adb01c6a9070010804`, without private Git history. The original MIT license is retained.
