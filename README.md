# pi-reasoning-by-thinking

A small [Pi](https://pi.dev) extension that maps Pi's current thinking level to a provider request parameter. Rules are selected by exact provider and model IDs, so different local models or API-compatible providers can use different token budgets or reasoning-effort values.

## Install

```bash
pi install git:https://github.com/erathaowl/pi-reasoning-by-thinking
```

Review third-party Pi extensions before installing them: extensions run with your user permissions.

## Configure

Create `reasoning-by-thinking.json` in one of Pi's configuration directories:

| Path | Scope |
| --- | --- |
| `~/.pi/agent/reasoning-by-thinking.json` | Global |
| `.pi/reasoning-by-thinking.json` | Current project |

`PI_CODING_AGENT_DIR` is respected for the global directory. Pi only reads the project file when the project is trusted. If both files exist, the project file replaces the global file.

This configuration reproduces the original token-budget behavior:

```json
{
  "rules": [
    {
      "provider": "llama-local",
      "model": "qwen3.8-27b",
      "parameter": "thinking_budget_tokens",
      "effort": {
        "low": 4096,
        "medium": 8192,
        "xhigh": 12288
      }
    }
  ]
}
```

`parameter` is optional and defaults to `thinking_budget_tokens`:

```json
{
  "rules": [
    {
      "provider": "llama-local",
      "model": "qwen3.8-27b",
      "effort": {
        "low": 4096,
        "medium": 8192,
        "xhigh": 12288
      }
    }
  ]
}
```

String values can map Pi levels to a `reasoning_effort` field instead:

```json
{
  "rules": [
    {
      "provider": "openai-compatible",
      "model": "reasoning-model",
      "parameter": "reasoning_effort",
      "effort": {
        "off": null,
        "minimal": "minimal",
        "low": "low",
        "medium": "medium",
        "high": "high"
      }
    }
  ]
}
```

Restart Pi or run `/reload` after changing the file.

## Configuration reference

Each entry in `rules` supports:

- `provider`: exact, case-sensitive Pi provider ID.
- `model`: exact, case-sensitive Pi model ID.
- `parameter`: optional top-level request payload field; defaults to `thinking_budget_tokens`.
- `effort`: mapping from Pi thinking levels to a finite number, string, or `null`.

Supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

For a matching rule:

- A configured number or string is assigned to the payload field.
- `null` removes the field.
- `off` removes the field when no explicit `off` mapping exists.
- An unconfigured non-`off` level leaves the payload unchanged.

Multiple rules may target the same provider/model when they use different payload parameters. Duplicate provider/model/parameter combinations are rejected. Invalid configuration disables the extension for the session and displays an error when UI is available.

## Native Pi alternative

For OpenAI-compatible models configured with `compat.thinkingTokenBudgetField` (or `supportsThinkingTokenBudget`), Pi's native `thinkingBudgets` setting may be sufficient. This extension is useful when mappings must vary by provider/model or when a different request field such as `reasoning_effort` is required.

## Development

Requires Node.js 22 or newer for the test runner.

```bash
npm install
npm test
npm run check
```

The package uses Pi's `pi.extensions` manifest and keeps `@earendil-works/pi-coding-agent` as a peer dependency, following Pi package conventions.

## License

MIT
