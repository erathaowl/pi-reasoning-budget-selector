# pi-reasoning-budget-selector

A small [Pi](https://pi.dev) extension that adds a validated numeric reasoning budget to requests for exact provider/model pairs. Pi remains responsible for thinking levels, qualitative reasoning effort, and whether thinking is enabled.

## Install

```bash
pi install git:https://github.com/erathaowl/pi-reasoning-by-thinking
```

Review third-party Pi extensions before installing them: extensions run with your user permissions.

## Configuration

The extension uses one JSON file:

| Path | Scope |
| --- | --- |
| `~/.pi/agent/reasoning-budget-selector.json` | Global |
| `.pi/reasoning-budget-selector.json` | Current project |

`PI_CODING_AGENT_DIR` is respected for the global directory. A project file is used only in a trusted project. If both files exist, the project file completely replaces the global file; rules are not merged.

Existing configurations remain valid and default to `auto` mode and the built-in reasoning-budget message:

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

Manual file edits take effect after restarting Pi or running `/reload`. Changes made with `/reasoning-budget` take effect immediately.

## Reasoning budget modes

### Auto

```json
{
  "provider": "llama-local",
  "model": "qwen3.8-27b",
  "budgetMode": "auto",
  "budgets": {
    "low": 4096,
    "medium": 8192,
    "xhigh": 12288
  }
}
```

Pi's current thinking level selects `budgets[currentThinkingLevel]`. An unmapped non-off level leaves the payload unchanged. Omitting `budgetMode` is equivalent to `"auto"`.

### Custom

```json
{
  "provider": "llama-local",
  "model": "qwen3.8-27b",
  "budgetMode": "custom",
  "customBudget": 10000,
  "budgets": {
    "low": 4096,
    "medium": 8192,
    "xhigh": 12288
  }
}
```

Every non-off Pi thinking level uses `customBudget`. Automatic mappings remain stored but are ignored while custom mode is active, so switching back to `auto` does not lose them. Pi's qualitative thinking level and `reasoning_effort` are not changed.

### Off

```json
{
  "provider": "llama-local",
  "model": "qwen3.8-27b",
  "budgetMode": "off",
  "budgets": {
    "low": 4096,
    "medium": 8192
  }
}
```

No numeric budget or reasoning-budget message is sent. Existing `budgets` and `customBudget` values remain stored. Pi remains authoritative about whether reasoning itself is enabled.

Regardless of the configured mode, Pi thinking level `off` removes both the configured numeric parameter and `reasoning_budget_message`.

## Reasoning budget message

When the extension injects a numeric budget, it also sends this default message:

```text
...Wait, I'm overthinking this. Let's answer now.
```

Override it per rule with:

```json
{
  "reasoningBudgetMessage": "Enough thinking. Produce the final answer now."
}
```

The provider payload field is named:

```text
reasoning_budget_message
```

The message is sent only when this extension injects a numeric budget. Resetting it through `/reasoning-budget` removes `reasoningBudgetMessage` from JSON and restores the built-in default.

## `/reasoning-budget`

Run:

```text
/reasoning-budget
```

The command shows the active provider and model, current Pi thinking level, selected configuration scope/path, rule parameter, configured mode and mappings, custom budget, effective runtime budget, and effective message. It then offers:

```text
Set budget mode
Set custom budget
Set reasoning budget message
Reset reasoning budget message to default
Show current settings
Cancel
```

Mode behavior in the command:

- `off` preserves automatic mappings and any custom budget.
- `auto` requires at least one automatic mapping; the command never invents values.
- `custom` uses an existing valid custom budget or prompts for one.
- Setting a custom budget does not automatically switch modes.
- Custom budgets must be positive safe integers and must pass the active model's safety checks. Headroom warnings are displayed before saving.
- Message input must be non-empty. Its punctuation and whitespace are preserved.

If multiple rules match the active provider/model because they use different `parameter` values, the command asks which rule to edit. If no rule exists, it can create one using the default parameter for `off`, `custom`, a custom budget, or a custom message. It does not create automatic mappings.

The command always modifies the currently effective source:

```text
trusted project config exists -> project configuration
otherwise                     -> global configuration
```

If no file exists, it creates the global file and directory. It never silently edits global configuration while a trusted project configuration overrides it. Other rules, automatic mappings, custom budgets, and configured parameters are preserved. Files are written as two-space-indented JSON with a trailing newline. Successful changes reload the extension's in-memory rules immediately.

### Example: auto to custom

```text
/reasoning-budget
Mode: auto
Effective budget: 8192
> Set budget mode
> custom
Custom reasoning budget: 10000
Mode: custom
Custom budget: 10000
Effective budget: 10000
```

### Example: custom to off

```text
/reasoning-budget
Mode: custom
> Set budget mode
> off
Mode: off
Effective budget: disabled
```

The stored `customBudget` and `budgets` remain available for later use.

### Example: custom message to default

```text
/reasoning-budget
Reasoning budget message:
Enough thinking. Produce the final answer now.
> Reset reasoning budget message to default
Reasoning budget message:
...Wait, I'm overthinking this. Let's answer now.
```

## Configuration reference

Each entry in `rules` supports:

| Field | Required | Default | Validation and behavior |
| --- | --- | --- | --- |
| `provider` | Yes | — | Non-empty exact, case-sensitive Pi provider ID. Surrounding whitespace is trimmed. |
| `model` | Yes | — | Non-empty exact, case-sensitive Pi model ID. Surrounding whitespace is trimmed. |
| `parameter` | No | `thinking_budget_tokens` | Non-empty top-level numeric payload field. Surrounding whitespace is trimmed; `__proto__`, `constructor`, and `prototype` are forbidden. |
| `budgetMode` | No | `auto` | Must be `off`, `auto`, or `custom`. |
| `customBudget` | In custom mode | Undefined | Positive safe integer. Preserved when another mode is selected. |
| `budgets` | Yes | — | Mapping from supported non-off Pi thinking levels to positive safe integers. It may be empty for a rule created before mappings are configured. |
| `reasoningBudgetMessage` | No | Built-in default | Non-empty string. Content is preserved exactly after whitespace-only input is rejected. |

Known Pi levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. `off` is not allowed in `budgets`. Duplicate `provider` + `model` + `parameter` combinations, unknown properties or levels, invalid values, and unsafe parameter names are rejected. Invalid configuration disables rules for the current session and displays an error when UI is available.

Rules match provider and model IDs exactly and case-sensitively. Different parameters may be configured for the same provider/model pair.

## Runtime budget safety

The effective budget is:

```text
auto   -> budgets[currentThinkingLevel]
custom -> customBudget
off    -> none
```

Before sending any effective budget, the extension reads `contextWindow` and `maxTokens` from the active model metadata and requires:

```text
budget < maxTokens < contextWindow
```

All three values must be positive safe integers. An invalid relationship displays an error when UI is available, aborts the current agent operation, and does not inject the budget.

The extension warns when either margin is below 4096 tokens:

```text
output headroom  = maxTokens - budget
context headroom = contextWindow - maxTokens
```

Warnings do not block requests and are deduplicated within the current session. The same validation and warnings apply to automatic and custom budgets. No validation occurs when nothing will be injected, such as mode `off`, Pi level `off`, or an unmapped automatic level.

## Pi thinking configuration

Use Pi's model configuration for native thinking behavior. This extension does not change:

- `thinkingLevelMap`
- `reasoning_effort`
- `enable_thinking`
- `chat_template_kwargs`
- `preserve_thinking`
- model metadata, provider implementations, or server startup arguments

The concepts remain distinct:

```text
reasoning_effort
    = qualitative/model-specific level

thinking_budget_tokens (or the configured parameter)
    = numeric hard limit for reasoning
```

For llama.cpp, the server must allow request-level reasoning budgets. Do not enforce a conflicting fixed reasoning budget at server startup.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm test
npm run check
```

The package uses Pi's `pi.extensions` manifest and requires `@earendil-works/pi-coding-agent` 0.84.4 or newer.

## License

MIT
