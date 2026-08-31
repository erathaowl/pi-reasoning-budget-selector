import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyReasoningRules,
  DEFAULT_PARAMETER,
  loadEffectiveConfig,
  parseConfig,
  readConfigFile,
  type ReasoningRule,
} from "../extensions/config.ts";

test("parseConfig applies the default payload parameter", () => {
  const config = parseConfig({
    rules: [
      {
        provider: "llama-local",
        model: "qwen3.8-27b",
        effort: { low: 4096, medium: 8192, xhigh: 12288 },
      },
    ],
  });

  assert.deepEqual(config, {
    rules: [
      {
        provider: "llama-local",
        model: "qwen3.8-27b",
        parameter: DEFAULT_PARAMETER,
        effort: { low: 4096, medium: 8192, xhigh: 12288 },
      },
    ],
  });
});

test("parseConfig rejects unknown levels, unsafe parameters, and duplicate rules", () => {
  assert.throws(
    () =>
      parseConfig({
        rules: [{ provider: "p", model: "m", effort: { enormous: 1 } }],
      }),
    /unsupported thinking level/,
  );

  assert.throws(
    () =>
      parseConfig({
        rules: [
          {
            provider: "p",
            model: "m",
            parameter: "__proto__",
            effort: { low: 1 },
          },
        ],
      }),
    /parameter is not allowed/,
  );

  assert.throws(
    () =>
      parseConfig({
        rules: [
          { provider: "p", model: "m", effort: { low: 1 } },
          { provider: "p", model: "m", effort: { high: 2 } },
        ],
      }),
    /duplicates/,
  );
});

test("applyReasoningRules only updates exact provider and model matches", () => {
  const rules: ReasoningRule[] = [
    {
      provider: "llama-local",
      model: "qwen3.8-27b",
      parameter: "thinking_budget_tokens",
      effort: { low: 4096 },
    },
  ];
  const matchingPayload: Record<string, unknown> = { temperature: 0 };
  const otherPayload: Record<string, unknown> = { temperature: 0 };

  applyReasoningRules(matchingPayload, rules, "llama-local", "qwen3.8-27b", "low");
  applyReasoningRules(otherPayload, rules, "llama-local", "another-model", "low");

  assert.deepEqual(matchingPayload, { temperature: 0, thinking_budget_tokens: 4096 });
  assert.deepEqual(otherPayload, { temperature: 0 });
});

test("off and null remove a payload parameter", () => {
  const rule: ReasoningRule = {
    provider: "p",
    model: "m",
    parameter: "reasoning_effort",
    effort: { low: "low", high: null },
  };
  const offPayload: Record<string, unknown> = { reasoning_effort: "high" };
  const nullPayload: Record<string, unknown> = { reasoning_effort: "low" };

  applyReasoningRules(offPayload, [rule], "p", "m", "off");
  applyReasoningRules(nullPayload, [rule], "p", "m", "high");

  assert.equal(Object.hasOwn(offPayload, "reasoning_effort"), false);
  assert.equal(Object.hasOwn(nullPayload, "reasoning_effort"), false);
});

test("an explicit off value is sent instead of deleting the parameter", () => {
  const payload: Record<string, unknown> = { reasoning_effort: "high" };
  const rule: ReasoningRule = {
    provider: "p",
    model: "m",
    parameter: "reasoning_effort",
    effort: { off: "none" },
  };

  applyReasoningRules(payload, [rule], "p", "m", "off");

  assert.equal(payload.reasoning_effort, "none");
});

test("project configuration replaces global configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-reasoning-by-thinking-"));
  const globalPath = join(directory, "global.json");
  const projectPath = join(directory, "project.json");

  try {
    await writeFile(
      globalPath,
      JSON.stringify({ rules: [{ provider: "global", model: "m", effort: { low: 1 } }] }),
    );

    const globalConfig = await loadEffectiveConfig(globalPath, projectPath);
    assert.equal(globalConfig.rules[0]?.provider, "global");

    await writeFile(
      projectPath,
      JSON.stringify({ rules: [{ provider: "project", model: "m", effort: { low: 2 } }] }),
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
