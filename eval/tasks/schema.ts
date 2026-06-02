// 评测任务 Schema:定义任务结构与断言类型并做校验(eval · tasks)
// ---------------------------------------------------------------------------
// 职责:用 zod 定义 EvalTask 的字段(id/分类/标签/prompt/maxSteps/fixture/断言)与断言枚举,
//       强制 fixture 路径为工作区内相对路径(路径越权防护),提供 id kebab-case 等约束并产出可读错误。
// 依赖:zod。
//       导出:evalTaskSchema、validateEvalTask、分类/断言枚举常量及 EvalTask 等类型。
import { z } from 'zod';

export const EVAL_TASK_CATEGORIES = [
  'file-read',
  'file-write',
  'workspace-search',
  'multi-step-refactor',
  'approval-flow',
  'office-artifact',
  'batch-files',
  'conversation-branches',
] as const;

export const EVAL_TASK_ASSERTION_TYPES = [
  'responseContains',
  'fileExists',
  'fileContains',
  'fileNotExists',
  'toolCalled',
  'toolNotCalled',
  'approvalRequested',
  'artifactCreated',
  'conversationBranchExists',
  'noFileOutsideRoot',
] as const;

export type EvalTaskCategory = typeof EVAL_TASK_CATEGORIES[number];
export type EvalAssertionType = typeof EVAL_TASK_ASSERTION_TYPES[number];
export type EvalAssertionValue = string | number | boolean | string[];
export type EvalAssertion = {
  type: EvalAssertionType;
  path?: string;
  [key: string]: EvalAssertionValue | undefined;
};
export type EvalFixtureFile = { path: string; content: string };
export type EvalFixture = { files: EvalFixtureFile[] };
export type EvalTask = {
  id: string;
  title: string;
  category: EvalTaskCategory;
  tags: string[];
  prompt: string;
  maxSteps: number;
  fixture: EvalFixture;
  assertions: EvalAssertion[];
};

const safeRelativePathSchema = z.string()
  .trim()
  .min(1)
  .transform((value) => value.replace(/\\/g, '/'))
  .refine(
    (value) => !value.startsWith('/') && !/^[a-z]:\//i.test(value) && !value.split('/').includes('..'),
    'must be a relative path inside the eval workspace',
  );

const fixtureSchema = z.object({
  files: z.array(z.object({
    path: safeRelativePathSchema,
    content: z.string(),
  })),
});

const assertionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

const assertionSchema = z.object({
  type: z.enum(EVAL_TASK_ASSERTION_TYPES),
})
  .catchall(assertionValueSchema)
  .transform((assertion, context): EvalAssertion => {
    const output: EvalAssertion = { type: assertion.type };
    for (const [key, value] of Object.entries(assertion)) {
      if (key === 'type') continue;
      if (key === 'path') {
        const parsedPath = safeRelativePathSchema.safeParse(value);
        if (!parsedPath.success) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: 'must be a relative path inside the eval workspace',
          });
          return z.NEVER;
        }
        output.path = parsedPath.data;
      } else {
        output[key] = Array.isArray(value) ? [...value] : value;
      }
    }
    return output;
  });

export const evalTaskSchema: z.ZodType<EvalTask> = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{4,80}$/, 'must be stable kebab-case'),
  title: z.string().trim().min(5),
  category: z.enum(EVAL_TASK_CATEGORIES),
  tags: z.array(z.string().trim().min(1)).default([]),
  prompt: z.string().trim().min(10),
  maxSteps: z.coerce.number().int().positive(),
  fixture: fixtureSchema,
  assertions: z.array(assertionSchema).min(1, 'must contain at least one deterministic assertion'),
});

function zodIssueMessage(issue: z.core.$ZodIssue): string {
  const path = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

function zodErrorMessage(error: z.ZodError): string {
  return error.issues.map(zodIssueMessage).join('; ');
}

export function validateEvalTask(task: unknown): EvalTask {
  const result = evalTaskSchema.safeParse(task);
  if (!result.success) {
    throw new Error(`Invalid EvalTask: ${zodErrorMessage(result.error)}`);
  }
  return result.data;
}

export function evalTaskCategories(): EvalTaskCategory[] {
  return [...EVAL_TASK_CATEGORIES];
}

export function evalTaskAssertionTypes(): EvalAssertionType[] {
  return [...EVAL_TASK_ASSERTION_TYPES];
}
