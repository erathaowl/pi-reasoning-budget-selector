import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_PARAMETER,
  DEFAULT_REASONING_BUDGET_MESSAGE,
  getReasoningBudgetMessage,
  getReasoningBudgetMode,
  readConfigFile,
  resolveEffectiveConfigSource,
  resolveReasoningBudget,
  THINKING_LEVELS,
  type BudgetWarning,
  type ReasoningRule,
  type ReasoningRuleIdentity,
  type ReasoningRuleUpdate,
  type ThinkingLevel,
  updateReasoningRule,
  validateBudgetForModel,
} from "./config.ts";

export interface ReasoningBudgetCommandState {
  setRules(rules: readonly ReasoningRule[]): void;
  clearWarnings(): void;
}

export interface SettingsView {
  provider: string;
  model: string;
  configPath: string;
  configScope: "global" | "project";
  thinkingLevel: ThinkingLevel;
  rule?: ReasoningRule;
}

export type CustomBudgetInputResult =
  | { value: number }
  | { error: string };

const ACTIONS = [
  "Set budget mode",
  "Set custom budget",
  "Set reasoning budget message",
  "Reset reasoning budget message to default",
  "Show current settings",
  "Cancel",
] as const;

export function parseCustomBudgetInput(input: string): CustomBudgetInputResult {
  if (!/^[1-9]\d*$/.test(input)) {
    return { error: "Custom budget must be a positive integer." };
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value)) {
    return { error: "Custom budget must be a positive safe integer." };
  }
  return { value };
}

export function renderReasoningBudgetSettings(view: SettingsView): string {
  const rule = view.rule;
  const mode = rule === undefined ? "auto" : getReasoningBudgetMode(rule);
  const message = rule === undefined
    ? DEFAULT_REASONING_BUDGET_MESSAGE
    : getReasoningBudgetMessage(rule);
  const effectiveBudget =
    rule === undefined ? undefined : resolveReasoningBudget(rule, view.thinkingLevel);
  const lines = [
    "Reasoning budget settings",
    "",
    `Provider: ${view.provider}`,
    `Model: ${view.model}`,
    `Config: ${view.configPath} (${view.configScope})`,
    `Rule parameter: ${rule?.parameter ?? DEFAULT_PARAMETER}`,
    `Rule: ${rule === undefined ? "not configured" : "configured"}`,
    "",
    `Mode: ${mode}`,
    `Current thinking level: ${view.thinkingLevel}`,
  ];

  if (mode === "custom") {
    lines.push(`Custom budget: ${rule?.customBudget ?? "not configured"}`);
  }

  const effectiveLabel =
    view.thinkingLevel === "off" || mode === "off"
      ? "disabled"
      : effectiveBudget === undefined
        ? "not configured"
        : String(effectiveBudget);
  lines.push(`Effective budget: ${effectiveLabel}`, "", "Auto budgets:");

  let mappedBudgetCount = 0;
  for (const level of THINKING_LEVELS) {
    if (level === "off") continue;
    const budget = rule?.budgets[level];
    if (budget === undefined) continue;
    mappedBudgetCount++;
    lines.push(`  ${level}: ${budget}`);
  }
  if (mappedBudgetCount === 0) lines.push("  (none configured)");

  lines.push("", "Reasoning budget message:", message);
  return lines.join("\n");
}

function notifyWarnings(
  ctx: ExtensionCommandContext,
  warnings: readonly BudgetWarning[],
  budget: number,
): void {
  const model = ctx.model;
  if (!model) return;
  for (const warning of warnings) {
    const message =
      warning.type === "output-headroom"
        ? `Budget ${budget} leaves only ${warning.headroom} output tokens (maxTokens=${model.maxTokens}).`
        : `The model leaves only ${warning.headroom} tokens between maxTokens and contextWindow.`;
    ctx.ui.notify(message, "warning");
  }
}

function validateCustomBudget(
  ctx: ExtensionCommandContext,
  budget: number,
): boolean {
  const model = ctx.model;
  if (!model) return false;
  const validation = validateBudgetForModel(budget, model.contextWindow, model.maxTokens);
  if (validation.error) {
    ctx.ui.notify(`Custom budget is invalid: ${validation.error}`, "error");
    return false;
  }
  notifyWarnings(ctx, validation.warnings, budget);
  return true;
}

async function requestValidCustomBudget(
  ctx: ExtensionCommandContext,
  currentBudget?: number,
): Promise<number | undefined> {
  const prompt = currentBudget === undefined
    ? "Enter a positive integer token budget"
    : `Current value: ${currentBudget}`;
  const input = await ctx.ui.input("Custom reasoning budget", prompt);
  if (input === undefined) return undefined;

  const parsed = parseCustomBudgetInput(input);
  if ("error" in parsed) {
    ctx.ui.notify(parsed.error, "error");
    return undefined;
  }
  return validateCustomBudget(ctx, parsed.value) ? parsed.value : undefined;
}

function identityFor(
  provider: string,
  model: string,
  rule: ReasoningRule | undefined,
): ReasoningRuleIdentity {
  return {
    provider,
    model,
    parameter: rule?.parameter ?? DEFAULT_PARAMETER,
  };
}

async function selectRule(
  ctx: ExtensionCommandContext,
  matchingRules: readonly ReasoningRule[],
): Promise<ReasoningRule | undefined | null> {
  if (matchingRules.length === 0) return undefined;
  if (matchingRules.length === 1) return matchingRules[0];

  const options = matchingRules.map((rule) => rule.parameter);
  const parameter = await ctx.ui.select("Select the budget parameter rule to edit", options);
  if (parameter === undefined) return null;
  return matchingRules.find((rule) => rule.parameter === parameter) ?? null;
}

export async function runReasoningBudgetCommand(
  ctx: ExtensionCommandContext,
  globalPath: string,
  projectPath: string | undefined,
  state: ReasoningBudgetCommandState,
): Promise<void> {
  if (!ctx.hasUI) return;
  const model = ctx.model;
  if (!model) {
    ctx.ui.notify("No active model is available.", "error");
    return;
  }

  try {
    const source = await resolveEffectiveConfigSource(globalPath, projectPath);
    const config = (await readConfigFile(source.path)) ?? { rules: [] };
    const matchingRules = config.rules.filter(
      (rule) => rule.provider === model.provider && rule.model === model.id,
    );
    const selection = await selectRule(ctx, matchingRules);
    if (selection === null) return;
    let selectedRule: ReasoningRule | undefined = selection;

    const render = (): string =>
      renderReasoningBudgetSettings({
        provider: model.provider,
        model: model.id,
        configPath: source.path,
        configScope: source.scope,
        thinkingLevel: (ctx.thinkingLevel ?? "off") as ThinkingLevel,
        ...(selectedRule === undefined ? {} : { rule: selectedRule }),
      });

    ctx.ui.notify(render(), "info");
    const action = await ctx.ui.select("Reasoning budget action", [...ACTIONS]);
    if (action === undefined || action === "Cancel") return;
    if (action === "Show current settings") {
      ctx.ui.notify(render(), "info");
      return;
    }

    const identity = identityFor(model.provider, model.id, selectedRule);
    let update: ReasoningRuleUpdate | undefined;

    if (action === "Set budget mode") {
      const mode = await ctx.ui.select("Reasoning budget mode", ["off", "auto", "custom"]);
      if (mode === undefined) return;

      if (mode === "auto") {
        if (Object.keys(selectedRule?.budgets ?? {}).length === 0) {
          ctx.ui.notify(
            "Auto mode cannot select a budget because this rule has no automatic budget mappings.",
            "error",
          );
          return;
        }
        update = { budgetMode: "auto" };
      } else if (mode === "off") {
        update = { budgetMode: "off" };
      } else {
        let customBudget = selectedRule?.customBudget;
        if (customBudget === undefined) {
          customBudget = await requestValidCustomBudget(ctx);
          if (customBudget === undefined) return;
        } else if (!validateCustomBudget(ctx, customBudget)) {
          return;
        }
        update = { budgetMode: "custom", customBudget };
      }
    } else if (action === "Set custom budget") {
      const customBudget = await requestValidCustomBudget(ctx, selectedRule?.customBudget);
      if (customBudget === undefined) return;
      update = { customBudget };
    } else if (action === "Set reasoning budget message") {
      const currentMessage = selectedRule === undefined
        ? DEFAULT_REASONING_BUDGET_MESSAGE
        : getReasoningBudgetMessage(selectedRule);
      const message = await ctx.ui.editor("Reasoning budget message", currentMessage);
      if (message === undefined) return;
      if (message.trim() === "") {
        ctx.ui.notify("Reasoning budget message must be a non-empty string.", "error");
        return;
      }
      update = { reasoningBudgetMessage: message };
    } else if (action === "Reset reasoning budget message to default") {
      if (selectedRule === undefined) {
        ctx.ui.notify("The reasoning budget message already uses the default.", "info");
        return;
      }
      update = { reasoningBudgetMessage: null };
    }

    if (update === undefined) return;
    await updateReasoningRule(source.path, identity, update);
    const reloaded = (await readConfigFile(source.path)) ?? { rules: [] };
    state.setRules(reloaded.rules);
    state.clearWarnings();
    selectedRule = reloaded.rules.find(
      (rule) =>
        rule.provider === identity.provider &&
        rule.model === identity.model &&
        rule.parameter === identity.parameter,
    );
    ctx.ui.notify(render(), "info");
  } catch (error) {
    ctx.ui.notify(`reasoning-budget-selector: ${(error as Error).message}`, "error");
  }
}
