import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyReasoningRules,
  DEFAULT_PARAMETER,
  loadEffectiveConfig,
  MIN_CONTEXT_HEADROOM_TOKENS,
  MIN_OUTPUT_HEADROOM_TOKENS,
  parseConfig,
  readConfigFile,
  type ReasoningRule,
  validateBudgetForModel,
} from "../extensions/config.ts";

test("parseConfig applies the default payload parameter", () => {
  const config = parseConfig({
    rules: [
      {
        provider: "llama-local",
        model: "qwen3.8-27b",
        budgets: { low: 4096, medium: 8192, xhigh: 12288 },
      },
    ],
  });

  assert.deepEqual(config, {
    rules: [
      {
        provider: "llama-local",
        model: "qwen3.8-27b",
        parameter: DEFAULT_PARAMETER,
        budgets: { low: 4096, medium: 8192, xhigh: 12288 },
      },
    ],
  });
});

test("parseConfig trims provider, model, and parameter", () => {
  const config = parseConfig({
    rules: [
      {
        provider: " llama-local ",
        model: " qwen3.8-27b ",
        parameter: " reasoning_budget_tokens ",
        budgets: { low: 4096 },
      },
    ],
  });

  assert.deepEqual(config.rules[0], {
    provider: "llama-local",
    model: "qwen3.8-27b",
    parameter: "reasoning_budget_tokens",
    budgets: { low: 4096 },
  });
});

test("parseConfig rejects unknown thinking levels", () => {
  assert.throws(
    () =>
      parseConfig({
        rules: [{ provider: "p", model: "m", budgets: { enormous: 1 } }],
      }),
    /unsupported thinking level/,
  );
});

test("parseConfig rejects off in budgets", () => {
  assert.throws(
    () =>
      parseConfig({
        rules: [{ provider: "p", model: "m", budgets: { off: 0 } }],
      }),
    /budgets\.off is not supported/,
  );
});

test("parseConfig rejects unsafe parameters", () => {
  for (const parameter of ["__proto__", "constructor", "prototype"]) {
    assert.throws(
      () =>
        parseConfig({
          rules: [{ provider: "p", model: "m", parameter, budgets: { low: 1 } }],
        }),
      /parameter is not allowed/,
    );
  }
});

test("parseConfig rejects duplicate provider, model, and parameter rules", () => {
  assert.throws(
    () =>
      parseConfig({
        rules: [
          { provider: "p", model: "m", budgets: { low: 1 } },
          {
            provider: " p ",
            model: " m ",
            parameter: ` ${DEFAULT_PARAMETER} `,
            budgets: { high: 2 },
          },
        ],
      }),
    /duplicates/,
  );
});

test("parseConfig accepts only positive safe-integer budgets", () => {
  const invalidBudgets: unknown[] = [
    -1,
    0,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "4096",
    null,
    {},
    [],
  ];

  for (const budget of invalidBudgets) {
    assert.throws(
      () =>
        parseConfig({
          rules: [{ provider: "p", model: "m", budgets: { low: budget } }],
        }),
      /budgets\.low must be a positive safe integer/,
    );
  }
});

function assertValidWithoutWarnings(
  budget: number,
  contextWindow: number,
  maxTokens: number,
): void {
  assert.deepEqual(validateBudgetForModel(budget, contextWindow, maxTokens), {
    warnings: [],
  });
}

test("validateBudgetForModel accepts a budget with comfortable margins", () => {
  assertValidWithoutWarnings(12288, 65536, 32768);
});

test("validateBudgetForModel rejects budgets at or above model limits", () => {
  assert.match(validateBudgetForModel(8192, 65536, 8192).error ?? "", /maxTokens/);
  assert.match(validateBudgetForModel(10000, 65536, 8192).error ?? "", /maxTokens/);
  assert.match(validateBudgetForModel(32768, 32768, 16384).error ?? "", /contextWindow/);
});

test("validateBudgetForModel rejects inconsistent model limits", () => {
  assert.match(validateBudgetForModel(4096, 32768, 32768).error ?? "", /maxTokens/);
  assert.match(validateBudgetForModel(4096, 32768, 65536).error ?? "", /maxTokens/);
});

test("validateBudgetForModel rejects invalid model metadata", () => {
  const invalidLimits = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ];

  for (const invalidLimit of invalidLimits) {
    assert.match(
      validateBudgetForModel(1, invalidLimit, 2).error ?? "",
      /contextWindow/,
    );
    assert.match(
      validateBudgetForModel(1, 10000, invalidLimit).error ?? "",
      /maxTokens/,
    );
  }
});

test("validateBudgetForModel warns only below the output headroom threshold", () => {
  const warning = validateBudgetForModel(14000, 65536, 16384);
  assert.equal(warning.error, undefined);
  assert.deepEqual(warning.warnings, [
    { type: "output-headroom", headroom: 2384 },
  ]);

  assertValidWithoutWarnings(
    16384 - MIN_OUTPUT_HEADROOM_TOKENS,
    65536,
    16384,
  );
});

test("validateBudgetForModel warns below the context headroom threshold", () => {
  const validation = validateBudgetForModel(4096, 32768, 30000);
  assert.equal(validation.error, undefined);
  assert.deepEqual(validation.warnings, [
    { type: "context-headroom", headroom: 2768 },
  ]);

  assertValidWithoutWarnings(4096, 32768, 32768 - MIN_CONTEXT_HEADROOM_TOKENS);
});

test("the intended Qwen budgets pass model validation silently", () => {
  for (const budget of [4096, 8192, 12288]) {
    assertValidWithoutWarnings(budget, 65536, 32768);
  }
});

test("applyReasoningRules only updates exact provider and model matches", () => {
  const rules: ReasoningRule[] = [
    {
      provider: "llama-local",
      model: "qwen3.8-27b",
      parameter: DEFAULT_PARAMETER,
      budgets: { low: 4096 },
    },
  ];
  const matchingPayload: Record<string, unknown> = { temperature: 0 };
  const otherProviderPayload: Record<string, unknown> = { temperature: 0 };
  const otherModelPayload: Record<string, unknown> = { temperature: 0 };

  applyReasoningRules(matchingPayload, rules, "llama-local", "qwen3.8-27b", "low");
  applyReasoningRules(otherProviderPayload, rules, "Llama-local", "qwen3.8-27b", "low");
  applyReasoningRules(otherModelPayload, rules, "llama-local", "Qwen3.8-27b", "low");

  assert.deepEqual(matchingPayload, { temperature: 0, thinking_budget_tokens: 4096 });
  assert.deepEqual(otherProviderPayload, { temperature: 0 });
  assert.deepEqual(otherModelPayload, { temperature: 0 });
});

test("off removes the configured budget parameter", () => {
  const payload: Record<string, unknown> = {
    temperature: 0,
    reasoning_budget_tokens: 8192,
  };
  const rule: ReasoningRule = {
    provider: "p",
    model: "m",
    parameter: "reasoning_budget_tokens",
    budgets: { low: 4096 },
  };

  applyReasoningRules(payload, [rule], "p", "m", "off");

  assert.deepEqual(payload, { temperature: 0 });
});

test("an unmapped non-off level leaves the payload unchanged", () => {
  const payload: Record<string, unknown> = { thinking_budget_tokens: 1234 };
  const rule: ReasoningRule = {
    provider: "provider",
    model: "model",
    parameter: DEFAULT_PARAMETER,
    budgets: { low: 4096 },
  };

  applyReasoningRules(payload, [rule], "provider", "model", "medium");

  assert.equal(payload.thinking_budget_tokens, 1234);
});

test("applying a budget does not alter Pi-managed thinking controls", () => {
  const payload: Record<string, unknown> = {
    reasoning_effort: "low",
    enable_thinking: true,
    chat_template_kwargs: { preserve_thinking: true },
  };
  const rule: ReasoningRule = {
    provider: "p",
    model: "m",
    parameter: DEFAULT_PARAMETER,
    budgets: { low: 4096 },
  };

  applyReasoningRules(payload, [rule], "p", "m", "low");

  assert.deepEqual(payload, {
    reasoning_effort: "low",
    enable_thinking: true,
    chat_template_kwargs: { preserve_thinking: true },
    thinking_budget_tokens: 4096,
  });
});

test("project configuration replaces global configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-reasoning-by-thinking-"));
  const globalPath = join(directory, "global.json");
  const projectPath = join(directory, "project.json");

  try {
    await writeFile(
      globalPath,
      JSON.stringify({ rules: [{ provider: "global", model: "m", budgets: { low: 1 } }] }),
    );

    const globalConfig = await loadEffectiveConfig(globalPath, projectPath);
    assert.equal(globalConfig.rules[0]?.provider, "global");

    await writeFile(
      projectPath,
      JSON.stringify({ rules: [{ provider: "project", model: "m", budgets: { low: 2 } }] }),
    );

    const projectConfig = await loadEffectiveConfig(globalPath, projectPath);
    assert.equal(projectConfig.rules.length, 1);
    assert.equal(projectConfig.rules[0]?.provider, "project");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("readConfigFile reports the source of invalid JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-reasoning-by-thinking-"));
  const path = join(directory, "invalid.json");

  try {
    await writeFile(path, "{");
    await assert.rejects(readConfigFile(path), new RegExp(`invalid JSON in .*invalid\\.json`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
