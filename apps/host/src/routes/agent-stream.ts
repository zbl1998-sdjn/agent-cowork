// Agent 流式聊天路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:Agent 对话主入口——以 SSE 流式驱动「工具循环」:装配工具集、装载分层记忆/图片、跑 Agent 循环
//       (审批/工具调用/收尾),全程发事件并落 run 记录/trace。是用户聊天体验的核心路由。
// 依赖:L1 kimi/agent(tool-loop/toolset/finalize)+ memory/workspace + L2 hooks/action-audit/run-trace
//       + 同层 agent-resume/session-model-config 等。导出:streamAgentChat。
import { loadLayeredMemory } from '../memory/memory-layers.js';
import { loadHooksConfig } from '../runtime/hooks.js';
import { getActionAuditBus } from '../runtime/action-audit.js';
import { createRunTrace } from '../runtime/run-trace.js';
import { loadImageContentParts } from '../workspace/image-loader.js';
import { omitUndefined } from '../util/object.js';
import { friendlyAgentError } from '../kimi/agent/model-resilience.js';
import { sse } from '../kimi/agent/finalize.js';
import { runAgentChat } from '../kimi/agent/tool-loop.js';
import { buildAgentToolset } from '../kimi/agent/toolset-builder.js';
import { resolveAgentRunStart } from './agent-resume.js';
import { applySessionModelConfig } from './session-model-config.js';
import { createAgentBudgetGuard, resolveAgentRunTimeoutMs } from './agent-stream-budget.js';
import { recordAgentRun } from './agent-stream-record.js';
import { maseRecallSessionMemory, maseRememberTurn } from '../memory/mase-bridge.js';
import { parseAgentStreamBody } from './agent-stream-schemas.js';
import type { HttpResponseLike } from '../http/request-utils.js';
import type { SandboxLike as HookSandboxLike } from '../runtime/hooks.js';
import type { ModelCall } from '../kimi/agent/model-resilience.js';
import type { RunAgentChatOptions } from '../kimi/agent/tool-loop.js';
import type { RequestContext, ApprovalRegistry as AgentApprovalRegistry } from '../kimi/agent/approval-gate.js';
import type { SandboxLike, SandboxLimits } from '../kimi/agent-tools.js';
import type { AgentDeps, Scheduler, SkillRegistry, ToolRegistry } from '../kimi/agent/toolset-builder.js';
import type { RunsIndexLike } from './agent-stream-record.js';

type ResponseLike = HttpResponseLike & {
  write(chunk?: string | Buffer): unknown;
  on?(event: string, listener: () => void): unknown;
};
type RequestLike = { on?(event: string, listener: () => void): unknown };
type RunController = { signal: AbortSignal };
type CancellationRegistry = {
  register(runId: string): RunController;
  cancel(runId: string): unknown;
  done(runId: string): unknown;
};
type SkillRegistryLike = SkillRegistry & {
  enabledSkills?: () => Array<{ id: unknown; name: unknown; description?: unknown }>;
};
type StreamRequestContext = RequestContext & { traceId?: unknown };
type ApprovalRegistry = AgentApprovalRegistry & { cancelByRun?: (runId: string) => unknown };
type RunEventsLike = { publish(runId: string, event: Record<string, unknown>): unknown };
type AgentOutcome = { text: string; steps: Array<Record<string, unknown>>; usage?: unknown };
export type StreamAgentChatOptions = {
  response: ResponseLike;
  requestContext: StreamRequestContext;
  body: unknown;
  kimiConfig: unknown;
  trustedRoot: string;
  runStoreRoot: string;
  runsIndex: RunsIndexLike;
  modelCall?: ModelCall;
  sandbox?: SandboxLike | null;
  sandboxLimits?: SandboxLimits;
  runEvents?: RunEventsLike | null;
  approvals?: ApprovalRegistry | null;
  toolRegistry?: ToolRegistry | null;
  skillRegistry?: SkillRegistryLike | null;
  userHome?: string;
  cancellation?: CancellationRegistry | null;
  request?: RequestLike | null;
  scheduler?: Scheduler | null;
};

export async function streamAgentChat({
  response,
  requestContext,
  body: rawBody,
  kimiConfig,
  trustedRoot,
  runStoreRoot,
  runsIndex,
  modelCall,
  sandbox,
  sandboxLimits,
  runEvents,
  approvals = null,
  toolRegistry = null,
  skillRegistry = null,
  userHome,
  cancellation = null,
  request = null,
  scheduler = null,
}: StreamAgentChatOptions): Promise<void> {
  const body = parseAgentStreamBody(rawBody);
  const { runId, startedAt, resumed, checkpointer, resumeState } = resolveAgentRunStart({ body, runStoreRoot });
  const runKimiConfig = applySessionModelConfig(kimiConfig, body);
  if (resumed && !resumeState) {
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: '没有找到可续跑的检查点。', runId }));
    return;
  }

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  const controller = cancellation ? cancellation.register(runId) : null;
  sse(response, 'start', { runId, resumed: !!resumeState });

  let finished = false;
  const onDisconnect = () => {
    if (finished) return;
    if (cancellation) cancellation.cancel(runId);
    if (approvals && typeof approvals.cancelByRun === 'function') approvals.cancelByRun(runId);
  };
  if (response && typeof response.on === 'function') response.on('close', onDisconnect);
  if (request && typeof request.on === 'function') request.on('close', onDisconnect);

  const events: Array<Record<string, unknown>> = [];
  const emit = (type: string, data: unknown): void => {
    const eventData = data && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : { value: data };
    events.push({ type, ...eventData });
    sse(response, type, data);
  };
  let outcome: AgentOutcome = { text: '', steps: [] };
  let status = 'succeeded';
  // MASE 记忆线程:稳定的「按租户/用户/会话」标识,读缝(时间线召回)与写缝(回写)共用。
  // conversationId 由 UI 每个对话窗口透传 → 各窗口对话时间线互不串(窗口隔离);UI 不传时回退 default。
  const maseConversation = String(body.conversationId ?? '').trim().slice(0, 64) || 'default';
  const maseThread = `cowork:${String(requestContext.tenantId ?? 'default')}:${String(requestContext.userId ?? 'default')}:${maseConversation}`;
  try {
    const agentCtx = { trustedRoot, sandbox, sandboxLimits, context: requestContext };
    const hooks = loadHooksConfig(omitUndefined({
      trustedRoot,
      sandbox: sandbox as unknown as HookSandboxLike | null | undefined,
      sandboxLimits,
    })) as unknown as RunAgentChatOptions['hooks'];
    const auditBus = getActionAuditBus(trustedRoot);
    const imageParts = Array.isArray(body.images) && body.images.length
      ? loadImageContentParts({ trustedRoot, paths: body.images })
      : [];
    const userContent = imageParts.length ? [{ type: 'text', text: String(body.prompt || '') }, ...imageParts] : null;
    const subAgentRunner: NonNullable<AgentDeps['runAgentChat']> = (args) => runAgentChat(args as RunAgentChatOptions);
    const agentTools = buildAgentToolset({
      ctx: agentCtx,
      toolRegistry,
      skillRegistry,
      runDeps: { runStoreRoot, runEvents, runsIndex },
      agentDeps: {
        kimiConfig: runKimiConfig,
        modelCall,
        approvals,
        autoApprove: body.autoApprove === true,
        hooks,
        emit,
        auditBus,
        runId,
        scheduler,
        runAgentChat: subAgentRunner,
      },
    });
    const lazyTools = agentTools.filter((t) => String(t.name).startsWith('mcp__'));
    const coreTools = agentTools.filter((t) => !String(t.name).startsWith('mcp__'));
    // 读缝:MASE 作为记忆后端——注入【最近对话(本线程时序)+ 当前事实 + 相关历史】到会话记忆层。
    const maseSessionMemory = await maseRecallSessionMemory(toolRegistry, String(body.prompt || ''), maseThread);
    const memory = loadLayeredMemory(omitUndefined({ trustedRoot, userHome, sessionMemory: maseSessionMemory || undefined }));
    const runTimeoutMs = resolveAgentRunTimeoutMs(body, runKimiConfig);
    const budgetGuard = createAgentBudgetGuard(omitUndefined({ body, kimiConfig: runKimiConfig, startedAt, runTimeoutMs }));
    const runTrace = createRunTrace(omitUndefined({ runId, runEvents }));
    const skills = skillRegistry && typeof skillRegistry.enabledSkills === 'function'
      ? skillRegistry.enabledSkills()
        .map((sk) => omitUndefined({
          id: String(sk.id || ''),
          name: String(sk.name || ''),
          description: typeof sk.description === 'string' ? sk.description : undefined,
        }))
        .filter((sk) => sk.id && sk.name)
      : [];
    outcome = await runAgentChat(omitUndefined({
      prompt: body.prompt,
      kimiConfig: runKimiConfig,
      trustedRoot,
      modelCall,
      tools: coreTools,
      lazyTools,
      hooks,
      memoryText: memory.text,
      skills,
      maxSteps: Math.min(Math.max(Number(body.maxSteps) || 8, 1), 16),
      verify: body.verify === true || body.thinking === 'deep',
      approvals,
      autoApprove: body.autoApprove === true,
      planMode: body.planMode === true,
      developerMode: body.developerMode === true || body.mode === 'developer',
      auditBus,
      emit,
      sandbox,
      sandboxLimits,
      runStoreRoot,
      runEvents,
      runsIndex,
      context: requestContext,
      signal: controller ? controller.signal : null,
      runId,
      userContent,
      clarifyBeforeModel: body.clarifyBeforeModel === true || body.autoClarify === true,
      budgetGuard,
      runTimeoutMs,
      checkpointer,
      resumeState: resumeState as RunAgentChatOptions['resumeState'],
      runTrace,
    }) as RunAgentChatOptions);
    if (controller && controller.signal.aborted) {
      status = 'cancelled';
      sse(response, 'cancelled', { runId, text: outcome.text, usage: outcome.usage });
    } else {
      sse(response, 'done', { runId, text: outcome.text, steps: outcome.steps, usage: outcome.usage });
    }
  } catch (err) {
    status = 'failed';
    sse(response, 'error', { error: friendlyAgentError(err, requestContext), runId });
  } finally {
    finished = true;
    if (cancellation) cancellation.done(runId);
    recordAgentRun({
      runStoreRoot,
      runsIndex,
      requestContext,
      runId,
      kimiConfig: runKimiConfig,
      body,
      trustedRoot,
      startedAt,
      status,
      prompt: body.prompt,
      outcome,
      events,
    });
    // 写缝:MASE 作为记忆后端——把成功一轮的「用户输入+助手回答」写回长期记忆。
    // 用稳定的会话 thread(按租户/用户)而非每轮变化的 runId,timeline 才能按"一段对话"归组。
    if (status === 'succeeded' && outcome.text) {
      await maseRememberTurn(toolRegistry, String(body.prompt || ''), outcome.text, maseThread);
    }
    response.end();
  }
}
