import { readFile } from "node:fs/promises";

export const CONFIG_FILE_NAME = "reasoning-budget-selector.json";
export const DEFAULT_PARAMETER = "thinking_budget_tokens";

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

export interface ReasoningRule {
  provider: string;
  model: string;
  parameter: string;
  budgets: Partial<Record<BudgetThinkingLevel, number>>;
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

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);
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
  if (typeof value !== "string") {
    throw new Error(`${location} must be a non-empty string`);
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    throw new Error(`${location} must be a non-empty string`);
  }

  return trimmed;
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

    if (
      typeof budget !== "number" ||
      !Number.isSafeInteger(budget) ||
      budget <= 0
    ) {
      throw new Error(`${location}.${level} must be a positive safe integer`);
    }

    budgets[level] = budget;
  }

  if (Object.keys(budgets).length === 0) {
    throw new Error(`${location} must define at least one thinking level`);
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
      new Set(["provider", "model", "parameter", "budgets"]),
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

    return {
      provider,
      model,
      parameter,
      budgets: parseBudgets(ruleValue.budgets, `${location}.budgets`),
    };
  });

  return { rules };
}

export async function readConfigFile(path: string): Promise<ReasoningConfig | undefined> {
  let contents: string;

  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`cannot read ${path}: ${(error as Error).message}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${(error as Error).message}`, { cause: error });
  }

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
    if (projectConfig !== undefined) {
      return projectConfig;
    }
  }

  return (await readConfigFile(globalPath)) ?? { rules: [] };
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
  for (const rule of rules) {
    if (rule.provider !== provider || rule.model !== model) {
      continue;
    }

    if (level === "off") {
      delete payload[rule.parameter];
    } else if (Object.hasOwn(rule.budgets, level)) {
      payload[rule.parameter] = rule.budgets[level];
    }
  }
}
