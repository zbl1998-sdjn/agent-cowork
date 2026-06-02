import type { EvalExecutor } from '../eval/runner.js';
import type { ModelRecord } from '../apps/host/src/runtime/model-recorder.js';

export type EvalExecutorMode = 'replay' | 'contract';

export type EvalExecutorEnvOptions = {
  recordsPath?: string | null;
  allowContractExecutor?: boolean;
};

export function readReplayRecords(recordsPath?: string | null): ModelRecord[] | null;

export function createEvalExecutorFromEnv(options?: EvalExecutorEnvOptions): {
  mode: EvalExecutorMode;
  executor: EvalExecutor;
};
