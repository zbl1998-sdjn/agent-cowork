// 运行捕获类型(host · L1 领域层 · recipes)
// ---------------------------------------------------------------------------
// 职责:集中描述 captureRun 读取的 run 记录、事件、产物和返回草稿结构,让 capture.ts 保持流程清晰。

export type ArtifactLike = {
  type?: unknown;
  path?: unknown;
  fullPath?: unknown;
  kind?: unknown;
  source?: unknown;
  encoding?: unknown;
  contentBase64?: unknown;
};

export type CapturedStep = {
  index: number;
  tool: string;
  status?: unknown;
  args?: unknown;
  result?: unknown;
  summary?: unknown;
};

export type CapturedArtifact = {
  path: string;
  kind: string;
  source?: unknown;
};

export type RunEvent = {
  type?: unknown;
  name?: unknown;
  tool?: unknown;
  args?: unknown;
  status?: unknown;
  result?: ArtifactLike;
  path?: unknown;
  operations?: ArtifactLike[];
  items?: ArtifactLike[];
};

export type ResultStep = {
  tool?: unknown;
  status?: unknown;
  ok?: unknown;
  summary?: unknown;
};

export type RunInput = {
  prompt?: unknown;
  summary?: unknown;
};

export type RunResult = {
  text?: unknown;
  steps?: ResultStep[];
};

export type RunError = {
  message?: unknown;
};

export type RunRecord = {
  recipeId?: unknown;
  command?: unknown;
  events?: RunEvent[];
  result?: RunResult;
  input?: RunInput;
  error?: RunError;
  type?: unknown;
  status?: unknown;
  mode?: unknown;
  provider?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
};

export type RunIndexEntry = {
  runPath?: unknown;
};

export type RunsIndexLike = {
  get(runId: string): RunIndexEntry | null | Promise<RunIndexEntry | null>;
};

export type RecordReader = (runId: string) => RunRecord | null | Promise<RunRecord | null>;

export type CaptureRunOptions = {
  runId?: unknown;
  runStoreRoot?: string | null;
  runsIndex?: RunsIndexLike | null;
  recordReader?: RecordReader | null;
};

export type CapturedRecipeDraft = {
  schemaVersion: 1;
  draft: true;
  sourceRunId: string;
  name: string;
  description: string;
  prompt: string;
  steps: CapturedStep[];
  artifacts: CapturedArtifact[];
  source: {
    type: string;
    status: string;
    mode: string;
    provider: string;
    recipeId: string | null;
    startedAt: unknown;
    finishedAt: unknown;
  };
  redacted: true;
};

export type CaptureRunResult = {
  ok: true;
  recipe: CapturedRecipeDraft;
};
