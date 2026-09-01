# pi-reasoning-budget-selector

A small [Pi](https://pi.dev) extension that maps Pi's current thinking level to a **numeric reasoning budget** for an exact provider/model pair. It adds one configurable top-level field to the provider request payload.

Pi remains responsible for supported thinking levels, enabling or disabling thinking, qualitative reasoning effort, and chat-template parameters. This extension only supplies a per-model numeric budget.

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

`PI_CODING_AGENT_DIR` is respected for the global directory. The extension reads project configuration only for trusted projects. When both files exist, the project file completely replaces the global file; configurations are not merged.

Example:

```json
{
  "rules": [
    {
      "provider": "llama-local",
      "model": "qwen3.8-27b",
      "budgets": {
        "low": 4096,
        "medium": 8192,
        "xhigh": 12288
      }
    }
  ]
}
```

This produces these mappings for that exact provider and model:

```text
low    -> 4096
medium -> 8192
xhigh  -> 12288
```

`parameter` is optional and defaults to `thinking_budget_tokens`. Servers expecting another numeric field can specify it explicitly:

```json
{
  "rules": [
    {
      "provider": "llama-local",
      "model": "qwen3.8-27b",
      "parameter": "reasoning_budget_tokens",
      "budgets": {
        "low": 4096,
        "medium": 8192
      }
    }
  ]
}
```

Restart Pi or run `/reload` after changing the file.

## Configuration reference

Each entry in `rules` has:

- `provider`: exact, case-sensitive Pi provider ID.
- `model`: exact, case-sensitive Pi model ID.
- `parameter`: optional top-level numeric request field; defaults to `thinking_budget_tokens`.
- `budgets`: mapping from Pi thinking levels to positive safe integers.

Known Pi levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Do not put `off` in `budgets`: when thinking is off, the extension always removes the configured parameter. An unconfigured non-off level leaves the payload unchanged.

Provider, model, and parameter values are trimmed. Empty values, unknown properties or levels, unsafe parameter names, budgets that are not positive safe integers, and duplicate provider/model/parameter combinations are rejected. Invalid configuration disables rules for the current session and displays an error when UI is available.

## Runtime budget safety

Before assigning a configured budget, the extension reads `contextWindow` and `maxTokens` from Pi's active model metadata and requires:

```text
budget < maxTokens < contextWindow
```

All three values must be positive safe integers. An invalid relationship displays an error when UI is available, aborts the current agent operation, and does not inject the budget. Warnings described below do not block requests.

The extension warns when either margin is below 4096 tokens:

```text
output headroom  = maxTokens - budget
context headroom = contextWindow - maxTokens
```

Output headroom is the output capacity remaining after the maximum reasoning allowance. Context headroom is the theoretical context space not reserved by the model's maximum output. Warnings are deduplicated within the current session.

For the example configuration above, model metadata of:

```text
contextWindow = 65536
maxTokens     = 32768

low    = 4096
medium = 8192
xhigh  = 12288
```

provides comfortable output and context margins and produces no warnings.

Only a configured budget for the active non-off thinking level is validated and assigned. An unconfigured level remains untouched, and `off` only removes the rule's parameter.

## Pi thinking configuration

Use Pi's model configuration for native thinking behavior. For example, `models.json` may contain:

```json
{
  "thinkingLevelMap": {
    "minimal": null,
    "low": "low",
    "medium": "medium",
    "high": null,
    "xhigh": "xhigh",
    "max": null
  },
  "compat": {
    "thinkingFormat": "chat-template",
    "chatTemplateKwargs": {
      "enable_thinking": {
        "$var": "thinking.enabled"
      },
      "preserve_thinking": true,
      "reasoning_effort": {
        "$var": "thinking.effort"
      }
    }
  }
}
```

Pi handles `thinkingLevelMap`, `enable_thinking`, `reasoning_effort`, and other chat-template thinking controls. The extension does not modify them; it only adds the configured numeric budget.

The two concepts are distinct:

```text
reasoning_effort
    = qualitative/model-specific level
    = e.g. "low", "medium", "xhigh"

thinking_budget_tokens
    = numeric hard limit for reasoning
    = e.g. 4096, 8192, 12288
```

For llama.cpp, the server must allow request-level reasoning budgets. Do not enforce a conflicting fixed reasoning budget at server startup for this setup.

## Development

Requires Node.js 22 or newer for the test runner.

```bash
npm install
npm test
npm run check
```

The package uses Pi's `pi.extensions` manifest and requires `@earendil-works/pi-coding-agent` 0.84.4 or newer.

## License

MIT
