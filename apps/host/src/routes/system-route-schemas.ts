// 系统路由输入协议(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:集中校验系统路由中来自 URL/path/body 的可变输入,让 system-routes 保持纯路由编排。
import { z } from 'zod';
import {
  decodePathSegment,
  sendJson,
  withJsonBody,
} from '../http/request-utils.js';
import { omitUndefined } from '../util/object.js';
import type {
  HttpRequestLike,
  HttpResponseLike,
  JsonBodyOptions,
} from '../http/request-utils.js';
import type {
  RuntimeDependencyCleanupPlanOptions,
  RuntimeDependencyInstallPlanOptions,
  RuntimeDependencyUpdatePlanOptions,
} from '../runtime/dependency-install-plan.js';

type RouteRequest = HttpRequestLike & { method?: string };
export type RuntimeDependencyPlanOptions =
  & RuntimeDependencyInstallPlanOptions
  & RuntimeDependencyCleanupPlanOptions
  & RuntimeDependencyUpdatePlanOptions;

const objectBody = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
const objectBodySchema = z.preprocess(objectBody, z.object({}).loose());
const optionalText = (max: number) => z.preprocess(
  (value) => (value == null || value === '' ? undefined : value),
  z.string().trim().min(1).max(max).optional(),
);
const selectedIdsSchema = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.array(z.string().trim().min(1).max(96), 'selectedIds must be an array of ids').optional(),
);
const freeBytesSchema = z.preprocess(
  (value) => (value == null || value === '' ? undefined : Number(value)),
  z.number().finite().nonnegative().optional(),
);
const safePathSegmentSchema = z.string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9._+-]+$/, 'path segment contains unsupported characters');

export const dependencyPlanBodySchema = objectBodySchema.pipe(z.object({
  selectedIds: selectedIdsSchema,
  freeBytes: freeBytesSchema,
  keepUserData: z.boolean().optional(),
  currentVersion: optionalText(80),
  targetVersion: optionalText(80),
  appDataRoot: optionalText(1000),
}).loose());

const desktopUpdateParamsSchema = z.object({
  target: safePathSegmentSchema,
  arch: safePathSegmentSchema,
  currentVersion: safePathSegmentSchema,
});
const cancelRunIdSchema = z.string()
  .trim()
  .min(1, 'runId is required')
  .max(80, 'runId is too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'runId is invalid');

function zodMessage(err: z.ZodError, fallback: string): string {
  return err.issues[0]?.message || fallback;
}

function decodedPathSegment(value: string): string | null {
  return decodePathSegment(value);
}

export function parseDesktopUpdateParams(
  response: HttpResponseLike,
  match: RegExpExecArray,
): z.output<typeof desktopUpdateParamsSchema> | null {
  const decoded = {
    target: decodedPathSegment(match[1] ?? ''),
    arch: decodedPathSegment(match[2] ?? ''),
    currentVersion: decodedPathSegment(match[3] ?? ''),
  };
  const parsed = desktopUpdateParamsSchema.safeParse(decoded);
  if (!parsed.success) {
    sendJson(response, 400, { error: zodMessage(parsed.error, 'invalid desktop update route') });
    return null;
  }
  return parsed.data;
}

export function parseCancelRunId(response: HttpResponseLike, rawRunId: string): string | null {
  const parsed = cancelRunIdSchema.safeParse(decodedPathSegment(rawRunId));
  if (!parsed.success) {
    sendJson(response, 400, { error: zodMessage(parsed.error, 'invalid run id') });
    return null;
  }
  return parsed.data;
}

export function dependencyPlanOptions(
  body: z.output<typeof dependencyPlanBodySchema>,
  fallbackAppDataRoot: string | null | undefined,
): RuntimeDependencyPlanOptions {
  return omitUndefined({
    selectedIds: body.selectedIds,
    freeBytes: body.freeBytes,
    keepUserData: body.keepUserData,
    currentVersion: body.currentVersion,
    targetVersion: body.targetVersion,
    appDataRoot: body.appDataRoot ?? fallbackAppDataRoot,
  });
}

export async function withParsedDependencyPlanBody(
  request: RouteRequest,
  response: HttpResponseLike,
  fallbackMessage: string,
  handler: (body: z.output<typeof dependencyPlanBodySchema>) => void | Promise<void>,
  options?: JsonBodyOptions,
): Promise<void> {
  await withJsonBody(request, response, async (body) => {
    const parsed = dependencyPlanBodySchema.safeParse(body);
    if (!parsed.success) {
      sendJson(response, 400, { error: zodMessage(parsed.error, fallbackMessage) });
      return;
    }
    await handler(parsed.data);
  }, options);
}
