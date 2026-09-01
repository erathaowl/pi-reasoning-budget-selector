import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PARAMETER, type ReasoningRule, type ThinkingLevel } from "../extensions/config.ts";
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
