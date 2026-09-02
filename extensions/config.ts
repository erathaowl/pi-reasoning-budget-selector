import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CONFIG_FILE_NAME = "reasoning-budget-selector.json";
export const DEFAULT_PARAMETER = "thinking_budget_tokens";
export const DEFAULT_REASONING_BUDGET_MESSAGE =
  "...Wait, I'm overthinking this. Let's answer now.";

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type BudgetThinkingLevel = Exclude<ThinkingLevel, "off">;
export type ReasoningBudgetMode = "off" | "auto" | "custom";

export interface ReasoningRule {
  provider: string;
  model: string;
  parameter: string;
  budgets: Partial<Record<BudgetThinkingLevel, number>>;
  budgetMode?: ReasoningBudgetMode;
  customBudget?: number;
  reasoningBudgetMessage?: string;
}

export interface ReasoningRuleIdentity {
  provider: string;
  model: string;
  parameter: string;
}

export interface ReasoningRuleUpdate {
  budgetMode?: ReasoningBudgetMode;
  customBudget?: number;
  reasoningBudgetMessage?: string | null;
}

export const MIN_OUTPUT_HEADROOM_TOKENS = 4096;
export const MIN_CONTEXT_HEADROOM_TOKENS = 4096;

export interface BudgetWarning {
  type: "output-headroom" | "context-headroom";
  headroom: number;
}

export interface BudgetValidation {
  error?: string;
  warnings: BudgetWarning[];
}

export interface ReasoningConfig {
  rules: ReasoningRule[];
}

export interface EffectiveConfigSource {
  path: string;
  scope: "global" | "project";
}

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);
const BUDGET_MODE_SET = new Set<string>(["off", "auto", "custom"]);
const UNSAFE_PARAMETERS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  location: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${location} contains unknown property ${JSON.stringify(key)}`);
    }
  }
}

function parseNonEmptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location} must be a non-empty string`);
  }

  return value.trim();
}

function parsePositiveSafeInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${location} must be a positive safe integer`);
  }
  return value;
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVEL_SET.has(value);
}

function parseBudgets(value: unknown, location: string): ReasoningRule["budgets"] {
  if (!isRecord(value)) {
    throw new Error(`${location} must be an object`);
  }

  const budgets: ReasoningRule["budgets"] = {};

  for (const [level, budget] of Object.entries(value)) {
    if (!isThinkingLevel(level)) {
      throw new Error(`${location} contains unsupported thinking level ${JSON.stringify(level)}`);
    }
    if (level === "off") {
      throw new Error(`${location}.off is not supported`);
    }
    budgets[level] = parsePositiveSafeInteger(budget, `${location}.${level}`);
  }

  return budgets;
}

export function parseConfig(value: unknown): ReasoningConfig {
  if (!isRecord(value)) {
    throw new Error("configuration must be an object");
  }

  assertKnownKeys(value, new Set(["rules"]), "configuration");
  if (!Array.isArray(value.rules)) {
    throw new Error("configuration.rules must be an array");
  }

  const identities = new Set<string>();
  const rules = value.rules.map((ruleValue, index): ReasoningRule => {
    const location = `configuration.rules[${index}]`;
    if (!isRecord(ruleValue)) {
      throw new Error(`${location} must be an object`);
    }

    assertKnownKeys(
      ruleValue,
      new Set([
        "provider",
        "model",
        "parameter",
        "budgets",
        "budgetMode",
        "customBudget",
        "reasoningBudgetMessage",
      ]),
      location,
    );

    const provider = parseNonEmptyString(ruleValue.provider, `${location}.provider`);
    const model = parseNonEmptyString(ruleValue.model, `${location}.model`);
    const parameter =
      ruleValue.parameter === undefined
        ? DEFAULT_PARAMETER
        : parseNonEmptyString(ruleValue.parameter, `${location}.parameter`);

    if (UNSAFE_PARAMETERS.has(parameter)) {
      throw new Error(`${location}.parameter is not allowed`);
    }

    const identity = `${provider}\0${model}\0${parameter}`;
    if (identities.has(identity)) {
      throw new Error(`${location} duplicates a provider, model, and parameter combination`);
    }
    identities.add(identity);

    let budgetMode: ReasoningBudgetMode | undefined;
    if (ruleValue.budgetMode !== undefined) {
      if (typeof ruleValue.budgetMode !== "string" || !BUDGET_MODE_SET.has(ruleValue.budgetMode)) {
        throw new Error(`${location}.budgetMode must be one of "off", "auto", or "custom"`);
      }
      budgetMode = ruleValue.budgetMode as ReasoningBudgetMode;
    }

    const customBudget =
      ruleValue.customBudget === undefined
        ? undefined
        : parsePositiveSafeInteger(ruleValue.customBudget, `${location}.customBudget`);
    if (budgetMode === "custom" && customBudget === undefined) {
      throw new Error(`${location}.customBudget is required when budgetMode is "custom"`);
    }

    let reasoningBudgetMessage: string | undefined;
    if (ruleValue.reasoningBudgetMessage !== undefined) {
      if (
        typeof ruleValue.reasoningBudgetMessage !== "string" ||
        ruleValue.reasoningBudgetMessage.trim() === ""
      ) {
        throw new Error(`${location}.reasoningBudgetMessage must be a non-empty string`);
      }
      reasoningBudgetMessage = ruleValue.reasoningBudgetMessage;
    }

    const rule: ReasoningRule = {
      provider,
      model,
      parameter,
      budgets: parseBudgets(ruleValue.budgets, `${location}.budgets`),
    };
    if (budgetMode !== undefined) rule.budgetMode = budgetMode;
    if (customBudget !== undefined) rule.customBudget = customBudget;
    if (reasoningBudgetMessage !== undefined) {
      rule.reasoningBudgetMessage = reasoningBudgetMessage;
    }
    return rule;
  });

  return { rules };
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read ${path}: ${(error as Error).message}`, { cause: error });
  }

  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${(error as Error).message}`, { cause: error });
  }
}

export async function readConfigFile(path: string): Promise<ReasoningConfig | undefined> {
  const value = await readJsonFile(path);
  if (value === undefined) return undefined;

  try {
    return parseConfig(value);
  } catch (error) {
    throw new Error(`invalid configuration in ${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

export async function loadEffectiveConfig(
  globalPath: string,
  projectPath?: string,
): Promise<ReasoningConfig> {
  if (projectPath !== undefined) {
    const projectConfig = await readConfigFile(projectPath);
    if (projectConfig !== undefined) return projectConfig;
  }
  return (await readConfigFile(globalPath)) ?? { rules: [] };
}

export async function resolveEffectiveConfigSource(
  globalPath: string,
  projectPath?: string,
): Promise<EffectiveConfigSource> {
  if (projectPath !== undefined) {
    try {
      await readFile(projectPath, "utf8");
      return { path: projectPath, scope: "project" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`cannot read ${projectPath}: ${(error as Error).message}`, { cause: error });
      }
    }
  }
  return { path: globalPath, scope: "global" };
}

export async function writeConfigFile(path: string, value: unknown): Promise<void> {
  parseConfig(value);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function updateReasoningRule(
  path: string,
  identity: ReasoningRuleIdentity,
  update: ReasoningRuleUpdate,
): Promise<ReasoningConfig> {
  const existingValue = await readJsonFile(path);
  const value: Record<string, unknown> =
    existingValue === undefined ? { rules: [] } : isRecord(existingValue) ? existingValue : {};

  const parsed = parseConfig(value);
  const index = parsed.rules.findIndex(
    (rule) =>
      rule.provider === identity.provider &&
      rule.model === identity.model &&
      rule.parameter === identity.parameter,
  );

  const rawRules = value.rules as Array<Record<string, unknown>>;
  let rawRule: Record<string, unknown>;
  if (index === -1) {
    rawRule = {
      provider: identity.provider,
      model: identity.model,
      parameter: identity.parameter,
      budgets: {},
    };
    rawRules.push(rawRule);
  } else {
    rawRule = rawRules[index] as Record<string, unknown>;
  }

  if (update.budgetMode !== undefined) rawRule.budgetMode = update.budgetMode;
  if (update.customBudget !== undefined) rawRule.customBudget = update.customBudget;
  if (update.reasoningBudgetMessage === null) {
    delete rawRule.reasoningBudgetMessage;
  } else if (update.reasoningBudgetMessage !== undefined) {
    rawRule.reasoningBudgetMessage = update.reasoningBudgetMessage;
  }

  const updated = parseConfig(value);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return updated;
}

export function getReasoningBudgetMode(rule: ReasoningRule): ReasoningBudgetMode {
  return rule.budgetMode ?? "auto";
}

export function getReasoningBudgetMessage(rule: ReasoningRule): string {
  return rule.reasoningBudgetMessage ?? DEFAULT_REASONING_BUDGET_MESSAGE;
}

export function resolveReasoningBudget(
  rule: ReasoningRule,
  thinkingLevel: ThinkingLevel,
): number | undefined {
  if (thinkingLevel === "off") return undefined;

  switch (getReasoningBudgetMode(rule)) {
    case "off":
      return undefined;
    case "custom":
      return rule.customBudget;
    case "auto":
      return rule.budgets[thinkingLevel];
  }
}

export function validateBudgetForModel(
  budget: number,
  contextWindow: number,
  maxTokens: number,
): BudgetValidation {
  const warnings: BudgetWarning[] = [];

  if (!Number.isSafeInteger(budget) || budget <= 0) {
    return { error: "reasoning budget must be a positive safe integer", warnings };
  }
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
    return { error: "contextWindow must be a positive safe integer", warnings };
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    return { error: "maxTokens must be a positive safe integer", warnings };
  }
  if (budget >= contextWindow) {
    return { error: "reasoning budget must be lower than contextWindow", warnings };
  }
  if (maxTokens >= contextWindow) {
    return { error: "maxTokens must be lower than contextWindow", warnings };
  }
  if (budget >= maxTokens) {
    return { error: "reasoning budget must be lower than maxTokens", warnings };
  }

  const outputHeadroom = maxTokens - budget;
  if (outputHeadroom < MIN_OUTPUT_HEADROOM_TOKENS) {
    warnings.push({ type: "output-headroom", headroom: outputHeadroom });
  }

  const contextHeadroom = contextWindow - maxTokens;
  if (contextHeadroom < MIN_CONTEXT_HEADROOM_TOKENS) {
    warnings.push({ type: "context-headroom", headroom: contextHeadroom });
  }

  return { warnings };
}

export function applyReasoningRules(
  payload: Record<string, unknown>,
  rules: readonly ReasoningRule[],
  provider: string,
  model: string,
  level: ThinkingLevel,
): void {
  const matchingRules = rules.filter(
    (rule) => rule.provider === provider && rule.model === model,
  );
  if (matchingRules.length === 0) return;

  if (level === "off") {
    for (const rule of matchingRules) delete payload[rule.parameter];
    delete payload.reasoning_budget_message;
    return;
  }

  let message: string | undefined;
  let removeMessage = false;
  for (const rule of matchingRules) {
    if (getReasoningBudgetMode(rule) === "off") {
      delete payload[rule.parameter];
      removeMessage = true;
      continue;
    }

    const budget = resolveReasoningBudget(rule, level);
    if (budget !== undefined) {
      payload[rule.parameter] = budget;
      message = getReasoningBudgetMessage(rule);
    }
  }

  if (message !== undefined) payload.reasoning_budget_message = message;
  else if (removeMessage) delete payload.reasoning_budget_message;
}
