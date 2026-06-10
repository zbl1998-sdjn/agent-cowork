// 工作区文件路由输入协议(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:集中定义 /api/files/*、/api/uploads/*、/api/context/* 路由的 JSON body schema,
//       让 route 主文件只保留调度与下层能力编排。
import { z } from 'zod';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike, JsonBodyOptions } from '../http/request-utils.js';
import type { UploadFile } from '../workspace/uploads.js';
import type { AttachmentInput } from '../workspace/attachment-context.js';

type RouteRequest = HttpRequestLike & { method?: string };

const objectBody = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
const optionalTrustedRootSchema = z.preprocess(
  (value) => (value == null || value === '' ? undefined : value),
  z.string().optional(),
);
const positiveIntegerSchema = z.preprocess(
  (value) => (value == null || value === '' ? undefined : Number(value)),
  z.number().int().positive().optional(),
);
const objectBodySchema = z.preprocess(objectBody, z.object({}).loose());
const pathField = (message: string): z.ZodString => z.string().trim().min(1, message);
const attachmentFileSchema: z.ZodType<string | AttachmentInput> = z.union([
  z.string(),
  z.object({
    path: z.string().optional(),
    fullPath: z.string().optional(),
    relativePath: z.string().optional(),
  }).loose(),
]);

export const treeBodySchema = objectBodySchema.pipe(z.object({
  root: pathField('body.root is required'),
  includeFiles: z.boolean().optional(),
  includeDirectories: z.boolean().optional(),
}).loose());

const uploadFileSchema: z.ZodType<UploadFile> = z.object({
  relativePath: z.string().optional(),
  name: z.string().optional(),
  contentBase64: z.string(),
  size: z.number().int().nonnegative(),
}).loose();
export const uploadBodySchema = objectBodySchema.pipe(z.object({
  trustedRoot: optionalTrustedRootSchema,
  files: z.array(uploadFileSchema, 'files must be an array').nonempty('files must be a non-empty array'),
}).loose());

export const readBodySchema = objectBodySchema.pipe(z.object({
  trustedRoot: optionalTrustedRootSchema,
  path: pathField('body.path is required'),
  maxSize: positiveIntegerSchema,
}).loose());

export const previewBodySchema = objectBodySchema.pipe(z.object({
  trustedRoot: optionalTrustedRootSchema,
  path: pathField('body.path is required'),
  maxBytes: positiveIntegerSchema,
}).loose());

export const extractBodySchema = objectBodySchema.pipe(z.object({
  trustedRoot: optionalTrustedRootSchema,
  path: pathField('body.path is required'),
  maxSize: z.unknown().optional(),
}).loose());

export const searchBodySchema = objectBodySchema.pipe(z.object({
  trustedRoot: optionalTrustedRootSchema,
  // 允许空 query:UI 的「引用文件」按钮插入裸 @ 时 query 为空,此时按"列出最近文件"处理(见 searchWorkspace)。
  query: z.string().trim().optional(),
  maxResults: positiveIntegerSchema,
  includeContent: z.boolean().optional(),
  maxContentBytes: positiveIntegerSchema,
}).loose());

export const contextBundleBodySchema = objectBodySchema.pipe(z.object({
  trustedRoot: optionalTrustedRootSchema,
  paths: z.array(z.string(), 'body.paths must be an array'),
  maxTextSize: positiveIntegerSchema,
}).loose());

export const attachmentContextBodySchema = objectBodySchema.pipe(z.object({
  trustedRoot: optionalTrustedRootSchema,
  files: z.array(attachmentFileSchema, 'files must be an array').optional(),
  maxSize: z.unknown().optional(),
}).loose());

function zodMessage(err: z.ZodError, fallback: string): string {
  return err.issues[0]?.message || fallback;
}

export async function withParsedWorkspaceBody<S extends z.ZodType>(
  request: RouteRequest,
  response: HttpResponseLike,
  schema: S,
  fallbackMessage: string,
  handler: (body: z.output<S>) => void | Promise<void>,
  options?: JsonBodyOptions,
): Promise<void> {
  await withJsonBody(request, response, async (body) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, { error: zodMessage(parsed.error, fallbackMessage) });
      return;
    }
    await handler(parsed.data);
  }, options);
}
