// Custom recipe persistence contracts (host · L1 · recipes).
export type CapturedStep = {
  index: number;
  tool: string;
  status?: string;
  args?: unknown;
  result?: unknown;
  summary?: unknown;
};

export type CapturedArtifact = {
  path: string;
  kind: string;
  source?: unknown;
};

export type CustomRecipeFormat = {
  kind: 'markdown';
  body: string;
};

export type CustomRecipe = {
  id: string;
  name: string;
  description: string;
  output: string;
  riskLevel: string;
  requiresSources?: boolean;
  format?: CustomRecipeFormat;
  custom: true;
  tenantId: string;
  userId: string;
  sourceRunId: string | null;
  prompt: string;
  steps: CapturedStep[];
  artifacts: CapturedArtifact[];
  redacted: true;
  createdAt: string;
  updatedAt: string;
};
