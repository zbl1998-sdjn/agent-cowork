// 配方执行类型(host · L1 领域层 · recipes)
// ---------------------------------------------------------------------------
// 职责:隔离 runRecipe 的外部注入接口和返回结构,保持执行流程文件聚焦在业务步骤。
import type { FileOperationInput } from '../workspace/file-operations.js';
import type { SourceLike } from './recipe-helpers.js';
import type { Recipe } from './registry.js';

export type RecipeSource = SourceLike;

export type RecipeError = Error & {
  statusCode?: number;
  payload?: Record<string, unknown>;
};

export type RunEventsLike = {
  publish(
    runId: string,
    event: Record<string, unknown>,
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
};

export type RunsIndexLike = {
  upsert(summary: unknown, context?: Record<string, unknown>): unknown;
};

export type RunRecipeOptions = {
  recipeId: string;
  trustedRoot: string;
  prompt?: unknown;
  files?: unknown[];
  maxSize?: unknown;
  context?: Record<string, unknown>;
  runStoreRoot: string;
  runEvents?: RunEventsLike | null;
  runsIndex?: RunsIndexLike | null;
  recipe?: Recipe | null;
  // 有模型配置时,支持 AI 路径的 recipe 会先用模型做结构化提取,提取不到再回退模板。
  modelConfig?: Record<string, unknown> | null;
};

export type RunRecipeResult = {
  ok: true;
  runId: string;
  runPath: string;
  recipe: Recipe;
  sources: RecipeSource[];
  operations: FileOperationInput[];
  // 该次产物是否由模型 AI 提取生成(true)还是模板兜底(false)。UI 据此显示「AI 生成」标识。
  aiGenerated: boolean;
  events: Record<string, unknown>[];
};
