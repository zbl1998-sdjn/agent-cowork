// ToolRegistry 输入 schema(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:集中校验工具 descriptor 与 MCP 工具清单。内置注册入口 strict;MCP 清单允许
//       协议扩展字段,但只投影注册表需要的 name/description/inputSchema。
import { z } from 'zod';
import { omitUndefined } from '../util/object.js';

type ToolHandler = (args?: unknown, ctx?: unknown) => unknown | Promise<unknown>;
type ParsedToolEntry = {
  name: string;
  description?: string;
  source?: string;
  inputSchema?: unknown;
  risk?: string;
  mutating?: boolean;
  requiresApproval?: boolean;
  handler: ToolHandler;
};
type ParsedMcpTool = { name: string; description?: string; inputSchema?: unknown };

const toolHandlerSchema = z.custom<ToolHandler>(
  (value) => typeof value === 'function',
  { message: 'handler must be a function' },
);

const toolEntrySchema = z.object({
  name: z.string().trim().min(1, 'name is required'),
  description: z.string().optional(),
  source: z.string().optional(),
  inputSchema: z.unknown().optional(),
  risk: z.string().optional(),
  mutating: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  handler: toolHandlerSchema,
}).strict();

const mcpToolSchema = z.object({
  name: z.string().trim().min(1, 'name is required'),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
}).loose();

function inputError(prefix: string, message: string): Error & { statusCode?: number } {
  const error = new Error(`${prefix}: ${message}`) as Error & { statusCode?: number };
  error.statusCode = 400;
  return error;
}

function zodIssueMessage(issue: z.core.$ZodIssue): string {
  const field = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return `${field}${issue.message}`;
}

export function parseToolEntry(entry: unknown): ParsedToolEntry {
  const result = toolEntrySchema.safeParse(entry);
  if (!result.success) {
    throw inputError('ToolRegistry.register', result.error.issues.map(zodIssueMessage).join('; '));
  }
  return omitUndefined(result.data) as ParsedToolEntry;
}

export function parseMcpTools(tools: unknown): ParsedMcpTool[] {
  const result = z.array(mcpToolSchema).safeParse(tools);
  if (!result.success) {
    throw inputError('ToolRegistry.registerMcpClient', result.error.issues.map(zodIssueMessage).join('; '));
  }
  return result.data.map((tool) => omitUndefined({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }) as ParsedMcpTool);
}
