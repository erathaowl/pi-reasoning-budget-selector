import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_PARAMETER,
  DEFAULT_REASONING_BUDGET_MESSAGE,
  type ReasoningRule,
  type ThinkingLevel,
} from "../extensions/config.ts";
import { handleBeforeProviderRequest } from "../extensions/index.ts";

interface Notification {
  message: string;
  type: "info" | "warning" | "error" | undefined;
}

function createContext(options: {
  provider?: string;
  model?: string;
  contextWindow?: number;
  maxTokens?: number;
  level?: ThinkingLevel;
} = {}): {
  ctx: ExtensionContext;
  notifications: Notification[];
  abortCount: () => number;
} {
  const notifications: Notification[] = [];
  let aborts = 0;
  const ctx = {
    model: {
      provider: options.provider ?? "p",
      id: options.model ?? "m",
      contextWindow: options.contextWindow ?? 65536,
      maxTokens: options.maxTokens ?? 32768,
    },
    thinkingLevel: options.level ?? "low",
    hasUI: true,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        notifications.push({ message, type });
      },
    },
    abort() {
      aborts++;
    },
  } as unknown as ExtensionContext;

  return { ctx, notifications, abortCount: () => aborts };
}

function rule(budget = 4096): ReasoningRule {
  return {
    provider: "p",
    model: "m",
    parameter: DEFAULT_PARAMETER,
    budgets: { low: budget },
  };
}

test("an invalid matching assignment notifies, aborts, and is not injected", () => {
  const payload: Record<string, unknown> = {};
  const runtime = createContext({ maxTokens: 4096 });

  handleBeforeProviderRequest({ payload }, runtime.ctx, [rule(4096)], new Set());

  assert.deepEqual(payload, {});
  assert.equal(runtime.abortCount(), 1);
  assert.equal(runtime.notifications.length, 1);
  assert.equal(runtime.notifications[0]?.type, "error");
  assert.match(runtime.notifications[0]?.message ?? "", /lower than maxTokens/);
});

test("a valid tight assignment warns once, does not abort, and is injected", () => {
  const payload: Record<string, unknown> = {};
  const runtime = createContext({ maxTokens: 16384 });
  const shownWarnings = new Set<string>();

  handleBeforeProviderRequest({ payload }, runtime.ctx, [rule(14000)], shownWarnings);
  handleBeforeProviderRequest({ payload }, runtime.ctx, [rule(14000)], shownWarnings);

  assert.equal(payload.thinking_budget_tokens, 14000);
  assert.equal(runtime.abortCount(), 0);
  assert.equal(runtime.notifications.length, 1);
  assert.equal(runtime.notifications[0]?.type, "warning");
  assert.match(runtime.notifications[0]?.message ?? "", /2384 output tokens/);
});

test("a valid comfortable assignment is injected silently", () => {
  const payload: Record<string, unknown> = {};
  const runtime = createContext();

  handleBeforeProviderRequest({ payload }, runtime.ctx, [rule()], new Set());

  assert.equal(payload.thinking_budget_tokens, 4096);
  assert.equal(payload.reasoning_budget_message, DEFAULT_REASONING_BUDGET_MESSAGE);
  assert.equal(runtime.abortCount(), 0);
  assert.deepEqual(runtime.notifications, []);
});

test("a different provider or model does not trigger runtime behavior", () => {
  const payload: Record<string, unknown> = { temperature: 0 };
  const runtime = createContext({ provider: "other", maxTokens: 1 });

  handleBeforeProviderRequest({ payload }, runtime.ctx, [rule()], new Set());

  assert.deepEqual(payload, { temperature: 0 });
  assert.equal(runtime.abortCount(), 0);
  assert.deepEqual(runtime.notifications, []);
});

test("off removes the parameter without validating model limits", () => {
  const payload: Record<string, unknown> = { thinking_budget_tokens: 4096 };
  const runtime = createContext({ level: "off", contextWindow: 0, maxTokens: 0 });

  handleBeforeProviderRequest({ payload }, runtime.ctx, [rule()], new Set());

  assert.deepEqual(payload, {});
  assert.equal(runtime.abortCount(), 0);
  assert.deepEqual(runtime.notifications, []);
});

test("an unmapped level leaves the payload untouched without validation", () => {
  const payload: Record<string, unknown> = { thinking_budget_tokens: 1234 };
  const runtime = createContext({ level: "medium", contextWindow: 0, maxTokens: 0 });

  handleBeforeProviderRequest({ payload }, runtime.ctx, [rule()], new Set());

  assert.deepEqual(payload, { thinking_budget_tokens: 1234 });
  assert.equal(runtime.abortCount(), 0);
  assert.deepEqual(runtime.notifications, []);
});

test("a custom message overrides the default", () => {
  const payload: Record<string, unknown> = {};
  const runtime = createContext();
  handleBeforeProviderRequest(
    { payload },
    runtime.ctx,
    [{ ...rule(), reasoningBudgetMessage: "Enough thinking." }],
    new Set(),
  );
  assert.equal(payload.reasoning_budget_message, "Enough thinking.");
});

test("custom mode uses one validated budget for every non-off level", () => {
  const customRule: ReasoningRule = {
    ...rule(),
    budgets: { low: 1, high: 2 },
    budgetMode: "custom",
    customBudget: 10000,
  };
  for (const level of ["minimal", "medium", "max"] as const) {
    const payload: Record<string, unknown> = {};
    const runtime = createContext({ level });
    handleBeforeProviderRequest({ payload }, runtime.ctx, [customRule], new Set());
    assert.equal(payload.thinking_budget_tokens, 10000);
    assert.equal(payload.reasoning_budget_message, DEFAULT_REASONING_BUDGET_MESSAGE);
    assert.equal(runtime.abortCount(), 0);
  }
});

test("custom mode uses model-limit errors and headroom warnings", () => {
  const customRule: ReasoningRule = {
    ...rule(),
    budgets: {},
    budgetMode: "custom",
    customBudget: 14000,
  };
  const warningRuntime = createContext({ level: "high", maxTokens: 16384 });
  handleBeforeProviderRequest({ payload: {} }, warningRuntime.ctx, [customRule], new Set());
  assert.match(warningRuntime.notifications[0]?.message ?? "", /2384 output tokens/);

  const invalidRuntime = createContext({ level: "max", maxTokens: 14000 });
  const payload: Record<string, unknown> = {};
  handleBeforeProviderRequest({ payload }, invalidRuntime.ctx, [customRule], new Set());
  assert.equal(invalidRuntime.abortCount(), 1);
  assert.deepEqual(payload, {});
});

test("configured off mode removes the budget and message without changing Pi controls", () => {
  const payload: Record<string, unknown> = {
    thinking_budget_tokens: 4096,
    reasoning_budget_message: "stale",
    reasoning_effort: "high",
    enable_thinking: true,
    chat_template_kwargs: { preserve_thinking: true },
  };
  const runtime = createContext({ level: "high", contextWindow: 0, maxTokens: 0 });
  handleBeforeProviderRequest(
    { payload },
    runtime.ctx,
    [{ ...rule(), budgetMode: "off" }],
    new Set(),
  );
  assert.deepEqual(payload, {
    reasoning_effort: "high",
    enable_thinking: true,
    chat_template_kwargs: { preserve_thinking: true },
  });
  assert.equal(runtime.abortCount(), 0);
});

test("Pi off removes the message for auto and custom rules", () => {
  for (const configuredRule of [
    rule(),
    { ...rule(), budgetMode: "custom" as const, customBudget: 8192 },
  ]) {
    const payload: Record<string, unknown> = {
      thinking_budget_tokens: 1,
      reasoning_budget_message: "stale",
    };
    const runtime = createContext({ level: "off", contextWindow: 0, maxTokens: 0 });
    handleBeforeProviderRequest({ payload }, runtime.ctx, [configuredRule], new Set());
    assert.deepEqual(payload, {});
  }
});
