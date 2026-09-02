import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  parseCustomBudgetInput,
  renderReasoningBudgetSettings,
  runReasoningBudgetCommand,
} from "../extensions/command.ts";
import {
  DEFAULT_PARAMETER,
  type ReasoningRule,
} from "../extensions/config.ts";

interface MockOptions {
  selects?: Array<string | undefined>;
  inputs?: Array<string | undefined>;
  editors?: Array<string | undefined>;
  level?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

function createCommandContext(options: MockOptions = {}) {
  const selects = [...(options.selects ?? [])];
  const inputs = [...(options.inputs ?? [])];
  const editors = [...(options.editors ?? [])];
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx = {
    hasUI: true,
    model: {
      provider: "p",
      id: "m",
      contextWindow: 65536,
      maxTokens: 32768,
    },
    thinkingLevel: options.level ?? "medium",
    ui: {
      async select() {
        return selects.shift();
      },
      async input() {
        return inputs.shift();
      },
      async editor() {
        return editors.shift();
      },
      notify(message: string, type?: string) {
        notifications.push(type === undefined ? { message } : { message, type });
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications };
}

function autoRule(): ReasoningRule {
  return {
    provider: "p",
    model: "m",
    parameter: DEFAULT_PARAMETER,
    budgets: { low: 4096, medium: 8192, xhigh: 12288 },
  };
}

async function withConfig(
  value: unknown,
  callback: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-reasoning-budget-command-"));
  const path = join(directory, "reasoning-budget-selector.json");
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
    await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function stateTracker() {
  let rules: readonly ReasoningRule[] = [];
  let clears = 0;
  return {
    state: {
      setRules(updated: readonly ReasoningRule[]) {
        rules = updated;
      },
      clearWarnings() {
        clears++;
      },
    },
    rules: () => rules,
    clears: () => clears,
  };
}

test("current settings rendering distinguishes auto, custom, and off", () => {
  const base = {
    provider: "p",
    model: "m",
    configPath: "/config.json",
    configScope: "global" as const,
    thinkingLevel: "medium" as const,
  };
  const auto = renderReasoningBudgetSettings({ ...base, rule: autoRule() });
  assert.match(auto, /Mode: auto/);
  assert.match(auto, /Effective budget: 8192/);
  assert.match(auto, /medium: 8192/);

  const custom = renderReasoningBudgetSettings({
    ...base,
    rule: { ...autoRule(), budgetMode: "custom", customBudget: 10000 },
  });
  assert.match(custom, /Mode: custom/);
  assert.match(custom, /Custom budget: 10000/);
  assert.match(custom, /Effective budget: 10000/);

  const off = renderReasoningBudgetSettings({
    ...base,
    rule: { ...autoRule(), budgetMode: "off" },
  });
  assert.match(off, /Mode: off/);
  assert.match(off, /Effective budget: disabled/);
});

test("custom budget input rejects malformed and unsafe values", () => {
  for (const input of ["", "0", "-1", "1.5", " 12", "12x", "9007199254740992"]) {
    assert.equal("error" in parseCustomBudgetInput(input), true);
  }
  assert.deepEqual(parseCustomBudgetInput("10000"), { value: 10000 });
});

test("the command changes auto to custom and reloads in-memory rules", async () => {
  await withConfig({ rules: [autoRule()] }, async (path) => {
    const runtime = createCommandContext({
      selects: ["Set budget mode", "custom"],
      inputs: ["10000"],
    });
    const tracker = stateTracker();
    await runReasoningBudgetCommand(runtime.ctx, path, undefined, tracker.state);

    assert.equal(tracker.rules()[0]?.budgetMode, "custom");
    assert.equal(tracker.rules()[0]?.customBudget, 10000);
    assert.deepEqual(tracker.rules()[0]?.budgets, autoRule().budgets);
    assert.equal(tracker.clears(), 1);
    assert.match(runtime.notifications.at(-1)?.message ?? "", /Effective budget: 10000/);
  });
});

test("the command switches custom to off without deleting stored values", async () => {
  const rule = { ...autoRule(), budgetMode: "custom", customBudget: 10000 };
  await withConfig({ rules: [rule] }, async (path) => {
    const runtime = createCommandContext({ selects: ["Set budget mode", "off"] });
    const tracker = stateTracker();
    await runReasoningBudgetCommand(runtime.ctx, path, undefined, tracker.state);
    assert.equal(tracker.rules()[0]?.budgetMode, "off");
    assert.equal(tracker.rules()[0]?.customBudget, 10000);
    assert.deepEqual(tracker.rules()[0]?.budgets, rule.budgets);
  });
});

test("the command switches off to auto only when mappings exist", async () => {
  await withConfig({ rules: [{ ...autoRule(), budgetMode: "off" }] }, async (path) => {
    const runtime = createCommandContext({ selects: ["Set budget mode", "auto"] });
    const tracker = stateTracker();
    await runReasoningBudgetCommand(runtime.ctx, path, undefined, tracker.state);
    assert.equal(tracker.rules()[0]?.budgetMode, "auto");
  });

  await withConfig({
    rules: [{ provider: "p", model: "m", budgets: {}, budgetMode: "off" }],
  }, async (path) => {
    const before = await readFile(path, "utf8");
    const runtime = createCommandContext({ selects: ["Set budget mode", "auto"] });
    await runReasoningBudgetCommand(runtime.ctx, path, undefined, stateTracker().state);
    assert.equal(await readFile(path, "utf8"), before);
    assert.match(runtime.notifications.at(-1)?.message ?? "", /no automatic budget mappings/);
  });
});

test("setting and resetting a custom message preserves its exact content", async () => {
  await withConfig({ rules: [autoRule()] }, async (path) => {
    const custom = "  Enough thinking.\nAnswer now.  ";
    const setRuntime = createCommandContext({
      selects: ["Set reasoning budget message"],
      editors: [custom],
    });
    const tracker = stateTracker();
    await runReasoningBudgetCommand(setRuntime.ctx, path, undefined, tracker.state);
    assert.equal(tracker.rules()[0]?.reasoningBudgetMessage, custom);

    const resetRuntime = createCommandContext({
      selects: ["Reset reasoning budget message to default"],
    });
    await runReasoningBudgetCommand(resetRuntime.ctx, path, undefined, tracker.state);
    const raw = JSON.parse(await readFile(path, "utf8")) as { rules: Array<Record<string, unknown>> };
    assert.equal(Object.hasOwn(raw.rules[0] ?? {}, "reasoningBudgetMessage"), false);
  });
});

test("invalid custom input and cancellation do not modify files", async () => {
  await withConfig({ rules: [autoRule()] }, async (path) => {
    const before = await readFile(path, "utf8");
    const invalid = createCommandContext({
      selects: ["Set custom budget"],
      inputs: ["1.5"],
    });
    await runReasoningBudgetCommand(invalid.ctx, path, undefined, stateTracker().state);
    assert.equal(await readFile(path, "utf8"), before);
    assert.match(invalid.notifications.at(-1)?.message ?? "", /positive integer/);

    const cancelled = createCommandContext({ selects: ["Cancel"] });
    await runReasoningBudgetCommand(cancelled.ctx, path, undefined, stateTracker().state);
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("the command displays and modifies the effective project source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-reasoning-budget-command-"));
  const globalPath = join(directory, "global.json");
  const projectPath = join(directory, "project.json");
  try {
    await writeFile(globalPath, JSON.stringify({ rules: [{ ...autoRule(), budgetMode: "auto" }] }));
    await writeFile(projectPath, JSON.stringify({ rules: [{ ...autoRule(), budgetMode: "custom", customBudget: 9000 }] }));
    const runtime = createCommandContext({ selects: ["Set budget mode", "off"] });
    const tracker = stateTracker();
    await runReasoningBudgetCommand(runtime.ctx, globalPath, projectPath, tracker.state);
    assert.match(runtime.notifications[0]?.message ?? "", new RegExp(projectPath.replaceAll("\\", "\\\\")));
    assert.equal(tracker.rules()[0]?.budgetMode, "off");
    assert.equal((JSON.parse(await readFile(globalPath, "utf8")) as { rules: ReasoningRule[] }).rules[0]?.budgetMode, "auto");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
