import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyReasoningRules,
  DEFAULT_PARAMETER,
  DEFAULT_REASONING_BUDGET_MESSAGE,
  getReasoningBudgetMessage,
  getReasoningBudgetMode,
  loadEffectiveConfig,
  MIN_CONTEXT_HEADROOM_TOKENS,
  MIN_OUTPUT_HEADROOM_TOKENS,
  parseConfig,
  readConfigFile,
  resolveEffectiveConfigSource,
  resolveReasoningBudget,
  type ReasoningRule,
  updateReasoningRule,
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

  assert.deepEqual(matchingPayload, {
    temperature: 0,
    thinking_budget_tokens: 4096,
    reasoning_budget_message: "...Wait, I'm overthinking this. Let's answer now.",
  });
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
    reasoning_budget_message: "...Wait, I'm overthinking this. Let's answer now.",
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

test("legacy rules use auto mode and the default message", () => {
  const rule = parseConfig({
    rules: [{ provider: "p", model: "m", budgets: { medium: 8192 } }],
  }).rules[0] as ReasoningRule;

  assert.equal(getReasoningBudgetMode(rule), "auto");
  assert.equal(getReasoningBudgetMessage(rule), DEFAULT_REASONING_BUDGET_MESSAGE);
  assert.equal(resolveReasoningBudget(rule, "medium"), 8192);
});

test("parseConfig accepts every explicit budget mode", () => {
  for (const value of [
    { budgetMode: "off" },
    { budgetMode: "auto" },
    { budgetMode: "custom", customBudget: 10000 },
  ]) {
    const rule = parseConfig({
      rules: [{ provider: "p", model: "m", budgets: {}, ...value }],
    }).rules[0];
    assert.equal(rule?.budgetMode, value.budgetMode);
  }
});

test("parseConfig rejects invalid modes and custom budgets", () => {
  assert.throws(
    () => parseConfig({ rules: [{ provider: "p", model: "m", budgets: {}, budgetMode: "manual" }] }),
    /budgetMode/,
  );
  assert.throws(
    () => parseConfig({ rules: [{ provider: "p", model: "m", budgets: {}, budgetMode: "custom" }] }),
    /customBudget is required/,
  );
  for (const customBudget of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "10"]) {
    assert.throws(
      () => parseConfig({ rules: [{ provider: "p", model: "m", budgets: {}, customBudget }] }),
      /customBudget must be a positive safe integer/,
    );
  }
});

test("parseConfig preserves non-empty reasoning messages exactly", () => {
  const message = "  Stop thinking now.  \n";
  const rule = parseConfig({
    rules: [{ provider: "p", model: "m", budgets: {}, reasoningBudgetMessage: message }],
  }).rules[0];
  assert.equal(rule?.reasoningBudgetMessage, message);

  for (const invalidMessage of ["", "  \n\t", 42]) {
    assert.throws(
      () => parseConfig({
        rules: [{ provider: "p", model: "m", budgets: {}, reasoningBudgetMessage: invalidMessage }],
      }),
      /reasoningBudgetMessage must be a non-empty string/,
    );
  }
});

test("custom and off payload modes have explicit runtime semantics", () => {
  const customRule: ReasoningRule = {
    provider: "p",
    model: "m",
    parameter: "budget",
    budgets: { low: 1, high: 2 },
    budgetMode: "custom",
    customBudget: 9000,
    reasoningBudgetMessage: "Answer now.",
  };
  for (const level of ["minimal", "low", "max"] as const) {
    const payload: Record<string, unknown> = { reasoning_effort: level };
    applyReasoningRules(payload, [customRule], "p", "m", level);
    assert.deepEqual(payload, {
      reasoning_effort: level,
      budget: 9000,
      reasoning_budget_message: "Answer now.",
    });
  }

  const offPayload: Record<string, unknown> = {
    budget: 9000,
    reasoning_budget_message: "stale",
    enable_thinking: true,
  };
  applyReasoningRules(
    offPayload,
    [{ ...customRule, budgetMode: "off" }],
    "p",
    "m",
    "high",
  );
  assert.deepEqual(offPayload, { enable_thinking: true });
});

test("Pi off removes the budget and message for auto and custom modes", () => {
  for (const rule of [
    {
      provider: "p",
      model: "m",
      parameter: "budget",
      budgets: { low: 4096 },
      budgetMode: "auto" as const,
    },
    {
      provider: "p",
      model: "m",
      parameter: "budget",
      budgets: {},
      budgetMode: "custom" as const,
      customBudget: 8192,
    },
  ]) {
    const payload: Record<string, unknown> = {
      budget: 123,
      reasoning_budget_message: "stale",
      preserve_thinking: true,
    };
    applyReasoningRules(payload, [rule], "p", "m", "off");
    assert.deepEqual(payload, { preserve_thinking: true });
  }
});

test("updating a rule preserves mappings, custom budget, and unrelated rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-reasoning-budget-selector-"));
  const path = join(directory, "nested", "config.json");
  try {
    await updateReasoningRule(
      path,
      { provider: "p", model: "m", parameter: DEFAULT_PARAMETER },
      { budgetMode: "custom", customBudget: 9000, reasoningBudgetMessage: "Answer." },
    );
    const created = await readConfigFile(path);
    assert.equal(created?.rules[0]?.customBudget, 9000);

    const unrelated = {
      provider: "other",
      model: "other-model",
      parameter: "tokens",
      budgets: { low: 100 },
    };
    await writeFile(
      path,
      JSON.stringify({
        rules: [
          {
            provider: "p",
            model: "m",
            budgets: { low: 4096 },
            budgetMode: "custom",
            customBudget: 9000,
            reasoningBudgetMessage: "Answer.",
          },
          unrelated,
        ],
      }),
    );
    await updateReasoningRule(
      path,
      { provider: "p", model: "m", parameter: DEFAULT_PARAMETER },
      { budgetMode: "off", reasoningBudgetMessage: null },
    );

    const raw = JSON.parse(await readFile(path, "utf8")) as {
      rules: Array<Record<string, unknown>>;
    };
    assert.deepEqual(raw.rules[0]?.budgets, { low: 4096 });
    assert.equal(raw.rules[0]?.customBudget, 9000);
    assert.equal(raw.rules[0]?.budgetMode, "off");
    assert.equal(Object.hasOwn(raw.rules[0] ?? {}, "reasoningBudgetMessage"), false);
    assert.deepEqual(raw.rules[1], unrelated);
    assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
    assert.match(await readFile(path, "utf8"), /\n  "rules": \[/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("effective config source prefers an existing project file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-reasoning-budget-selector-"));
  const globalPath = join(directory, "global.json");
  const projectPath = join(directory, "project.json");
  try {
    assert.deepEqual(await resolveEffectiveConfigSource(globalPath, projectPath), {
      path: globalPath,
      scope: "global",
    });
    await writeFile(projectPath, "{\"rules\":[]}");
    assert.deepEqual(await resolveEffectiveConfigSource(globalPath, projectPath), {
      path: projectPath,
      scope: "project",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
