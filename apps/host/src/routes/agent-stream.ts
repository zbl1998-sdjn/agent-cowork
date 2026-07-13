// Agent 流式聊天路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:Agent 对话主入口——以 SSE 流式驱动「工具循环」:装配工具集、装载分层记忆/图片、跑 Agent 循环
//       (审批/工具调用/收尾),全程发事件并落 run 记录/trace。是用户聊天体验的核心路由。
// 依赖:L1 kimi/agent(tool-loop/toolset/finalize)+ memory/workspace + L2 hooks/action-audit/run-trace
//       + 同层 agent-resume/session-model-config 等。导出:streamAgentChat。
import { loadLayeredMemory } from '../memory/memory-layers.js';
import { isMemoryActiveForRoot } from '../memory/memory-control.js';
import { redactText } from '../security/redaction.js';
import { resolvePermissionMode, shouldAutoApproveLowRisk } from '../security/permission-mode.js';
import { loadHooksConfig } from '../runtime/hooks.js';
import { getActionAuditBus } from '../runtime/action-audit.js';
import { createRunTrace } from '../runtime/run-trace.js';
import { loadImageContentParts } from '../workspace/image-loader.js';
import { omitUndefined } from '../util/object.js';
import { friendlyAgentError } from '../engine/agent/model-resilience.js';
import { sse } from '../engine/agent/finalize.js';
import { runAgentChat } from '../engine/agent/tool-loop.js';
import { buildAgentToolset } from '../engine/agent/toolset-builder.js';
import { resolveAgentRunStart } from './agent-resume.js';
import { applySessionModelConfig } from './session-model-config.js';
import { createAgentBudgetGuard, resolveAgentRunTimeoutMs } from './agent-stream-budget.js';
import { recordAgentRun } from './agent-stream-record.js';
import { maseRecallSessionMemory, maseRememberTurn } from '../memory/mase-bridge.js';
import { maybeConsolidatePreviousConversation } from '../memory/consolidate-trigger.js';
import type { ConsolidateCallJson } from '../memory/consolidate.js';
import { callModelForJson, type ModelCaller } from '../recipes/model-recipe-extract.js';
import type { ModelConfig } from '../engine/provider/types.js';
import { parseAgentStreamBody } from './agent-stream-schemas.js';
import { resolveAgentContextOptions, resolveAgentConvergenceOptions } from './agent-stream-context.js';
import { cancelApprovalsForDisconnectedRun, type DisconnectApprovalRegistry } from './agent-stream-disconnect.js';
import { sanitizeAgentEventData } from './agent-stream-events.js';
import { buildMaseMemoryThread, recallBuiltinAgentMemory, rememberBuiltinConversation } from './agent-stream-memory.js';
import { createAgentTemplateMode } from './agent-template-mode.js';
import type { HttpResponseLike } from '../http/request-utils.js';
import type { SandboxLike as HookSandboxLike } from '../runtime/hooks.js';
import type { ModelCall } from '../engine/agent/model-resilience.js';
import type { RunAgentChatOptions } from '../engine/agent/tool-loop.js';
import type { RequestContext } from '../engine/agent/approval-gate.js';
import type { SandboxLike, SandboxLimits } from '../engine/agent-tools.js';
import type { AgentDeps, Scheduler, SkillRegistry, ToolRegistry } from '../engine/agent/toolset-builder.js';
import type { RunsIndexLike } from './agent-stream-record.js';
type ResponseLike = HttpResponseLike & {
  write(chunk?: string | Buffer): unknown;
  on?(event: string, listener: () => void): unknown;
};
type CancellationRegistry = {
  register(runId: string, context: RequestContext): { signal: AbortSignal };
  cancel(runId: string, reason: string, context: RequestContext): unknown;
  done(runId: string, context: RequestContext): unknown;
};
type SkillRegistryLike = SkillRegistry & {
  enabledSkills?: () => Array<{ id: unknown; name: unknown; description?: unknown }>;
};
type StreamRequestContext = RequestContext & { tenantId: string; userId: string; traceId?: unknown }; type RunEventsLike = { publish(runId: string, event: Record<string, unknown>): unknown };
type AgentOutcome = { text: string; steps: Array<Record<string, unknown>>; usage?: unknown; stepsExhausted?: boolean; autoContinues?: number };
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
  approvals?: DisconnectApprovalRegistry | null;
  toolRegistry?: ToolRegistry | null;
  skillRegistry?: SkillRegistryLike | null;
  userHome?: string;
  cancellation?: CancellationRegistry | null;
  request?: { on?(event: string, listener: () => void): unknown } | null;
  scheduler?: Scheduler | null;
};
export { cancelApprovalsForDisconnectedRun };
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
  const permissionMode = resolvePermissionMode(body);
  const autoApprove = shouldAutoApproveLowRisk(permissionMode);
  const planMode = permissionMode === 'plan';
  const { runId, startedAt, resumed, checkpointer, resumeState } = resolveAgentRunStart({ body, runStoreRoot, requestContext });
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
  const controller = cancellation ? cancellation.register(runId, requestContext) : null;
  sse(response, 'start', { runId, resumed: !!resumeState });
  let finished = false;
  const onDisconnect = () => {
    if (finished) return;
    if (cancellation) cancellation.cancel(runId, 'client disconnected', requestContext);
    cancelApprovalsForDisconnectedRun(approvals, runId, requestContext);
  };
  if (response && typeof response.on === 'function') response.on('close', onDisconnect);
  if (request && typeof request.on === 'function') request.on('close', onDisconnect);
  const events: Array<Record<string, unknown>> = [];
  const emit = (type: string, data: unknown): void => {
    const safeEventData = sanitizeAgentEventData(data);
    events.push({ type, ...safeEventData });
    sse(response, type, safeEventData);
  };
  let outcome: AgentOutcome = { text: '', steps: [] };
  let status = 'succeeded';
  // 记忆总闸(读/写共用):默认活跃,进 try 后按 memory-settings 覆写。声明在 try 外,
  // 好让 finally 的写缝也能读到;真赋值失败会被 catch 兜住并把 status 置 failed,不会误写。
  let memoryActive = true;
  // MASE 记忆线程:稳定的「按租户/用户/会话」标识,读缝(时间线召回)与写缝(回写)共用。
  // conversationId 由 UI 每个对话窗口透传 → 各窗口对话时间线互不串(窗口隔离);UI 不传时回退 default。
  const maseConversation = String(body.conversationId ?? '').trim().slice(0, 64) || 'default';
  const maseThread = buildMaseMemoryThread(requestContext, maseConversation);
  try {
    const agentCtx = { trustedRoot, sandbox, sandboxLimits, context: requestContext }; const templateMode = createAgentTemplateMode({ trustedRoot, context: requestContext, templateFiles: body.templateFiles || [], prompt: String(body.prompt || '') });
    const hooks = loadHooksConfig(omitUndefined({
      trustedRoot,
      sandbox: sandbox as unknown as HookSandboxLike | null | undefined,
      sandboxLimits,
    })) as unknown as RunAgentChatOptions['hooks'];
    const auditBus = getActionAuditBus(trustedRoot);
    const imageParts = Array.isArray(body.images) && body.images.length
      ? loadImageContentParts({ trustedRoot, paths: body.images })
      : [];
    const userContent = imageParts.length ? [{ type: 'text', text: templateMode.prompt }, ...imageParts] : null;
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
        autoApprove,
        planMode,
        hooks,
        emit,
        auditBus,
        runId,
        scheduler,
        runAgentChat: subAgentRunner,
      },
    });
    const activeTools = templateMode.lockTools(agentTools); const lazyTools = activeTools.filter((t) => String(t.name).startsWith('mcp__'));
    const coreTools = activeTools.filter((t) => !String(t.name).startsWith('mcp__'));
    // 记忆总闸:尊重用户「暂停/隐身/停用」开关(memory-settings)——非活跃时本轮既不注入也不回写,
    // 内置分层记忆与 MASE 记忆桥接对同一个开关保持一致(否则 UI 里的开关对实时对话形同虚设)。
    memoryActive = isMemoryActiveForRoot(trustedRoot, requestContext);
    // 惰性提炼触发:用户切到了另一个对话 → 后台把上一个对话缓冲提炼成主题知识(不 await、
    // 错误吞掉,不加聊天延迟)。提炼的模型调用经 callModelForJson 走 decideEgressPolicy 出站闸门
    // (与对话路径同一策略,机密档下同样拒绝出网);复用本轮 modelCall,缺省回落默认 provider。
    if (memoryActive) {
      const consolidateCallJson: ConsolidateCallJson = (a) => callModelForJson(omitUndefined({
        system: a.system,
        user: a.user,
        modelConfig: a.modelConfig as ModelConfig,
        modelCall: modelCall as unknown as ModelCaller | undefined,
        trustedRoot: a.trustedRoot,
      }));
      void maybeConsolidatePreviousConversation({
        trustedRoot,
        tenantId: requestContext.tenantId,
        userId: requestContext.userId,
        conversationId: maseConversation,
        modelConfig: runKimiConfig,
        callJson: consolidateCallJson,
      }).done;
    }
    // 读缝:MASE 作为记忆后端——注入【最近对话(本线程时序)+ 当前事实 + 相关历史】到会话记忆层。
    const maseSessionMemory = memoryActive
      ? await maseRecallSessionMemory(toolRegistry, String(body.prompt || ''), maseThread)
      : '';
    // 自带对话缓冲兜底:MASE 关闭/无召回时,用本地缓冲的「本会话最近若干轮」喂 session 层,
    // 让不接 MASE 也有多轮连续性(dogfood 2026-07-09 发现:此前同会话记忆 100% 依赖 MASE)。
    // MASE 在且有召回时行为不变(maseSessionMemory 非空优先),避免与 MASE 双重注入。
    const { sessionMemory, knowledgeText } = memoryActive
      ? recallBuiltinAgentMemory({
        trustedRoot, conversationId: maseConversation, prompt: String(body.prompt || ''),
        context: requestContext, maseSessionMemory,
      })
      : { sessionMemory: '', knowledgeText: '' };
    const memory = memoryActive
      ? loadLayeredMemory(omitUndefined({ trustedRoot, userHome, sessionMemory: sessionMemory || undefined }))
      : { text: '', layers: [] };
    // 读侧脱敏(纵深防御):记忆注入模型前统一过 redactText——即便历史遗留的旧凭据
    // 已落在 MASE/分层记忆/知识库存储里(写侧 DLP 守卫上线前),也不会被回放进模型上下文、
    // 进而外发给云端 provider。与写侧 carriesSecret 形成"写不进、读不出"双保险。
    const memoryText = redactText([memory.text, knowledgeText].filter(Boolean).join('\n\n')) || '';
    const runTimeoutMs = resolveAgentRunTimeoutMs(body, runKimiConfig);
    // 自适应压缩阈值:按本轮实际所选模型(含会话级 BYO 覆盖)的上下文窗口推导预算,
    // 请求已显式指定 maxContextTokens 时仍以显式值为准。
    const contextOptions = resolveAgentContextOptions(body, {
      provider: runKimiConfig.provider,
      model: runKimiConfig.model,
    });
    // 收敛行为运行时开关(KCW_STEP_NUDGE_RATIO / KCW_TOOL_DISCIPLINE),默认不改变行为。
    const convergenceOptions = resolveAgentConvergenceOptions();
    const budgetGuard = createAgentBudgetGuard(omitUndefined({ body, kimiConfig: runKimiConfig, startedAt, runTimeoutMs }));
    const runTrace = createRunTrace(omitUndefined({ runId, runEvents, context: requestContext }));
    const skills = !templateMode.active && skillRegistry && typeof skillRegistry.enabledSkills === 'function'
      ? skillRegistry.enabledSkills()
        .map((sk) => omitUndefined({
          id: String(sk.id || ''),
          name: String(sk.name || ''),
          description: typeof sk.description === 'string' ? sk.description : undefined,
        }))
        .filter((sk) => sk.id && sk.name)
      : [];
    outcome = await runAgentChat(omitUndefined({
      prompt: templateMode.prompt,
      kimiConfig: runKimiConfig,
      trustedRoot,
      modelCall,
      tools: coreTools,
      lazyTools,
      hooks,
      memoryText,
      skills,
      maxSteps: Math.min(Math.max(Number(body.maxSteps) || 20, 1), 40),
      // 自动续跑窗数:大任务跑满一窗还没做完时,自动再扩窗接着做(硬上限 = maxSteps*(1+此值))。
      // 默认 2(即最多 3 窗);可用 body.maxAutoContinues / 环境变量 KCW_MAX_AUTO_CONTINUE 覆盖,夹取 [0,10]。
      maxAutoContinues: Math.min(10, Math.max(0, Math.floor(Number(body.maxAutoContinues ?? process.env.KCW_MAX_AUTO_CONTINUE ?? 2) || 0))),
      verify: body.verify === true || body.thinking === 'deep',
      approvals,
      autoApprove,
      planMode,
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
      // 跨运行稳定的会话 id 作前缀缓存键:同一对话窗口的多轮追问复用缓存(官方建议用 session/task id)。
      cacheKey: maseConversation,
      userContent,
      clarifyBeforeModel: body.clarifyBeforeModel === true || body.autoClarify === true,
      contextOptions,
      ...convergenceOptions,
      budgetGuard,
      runTimeoutMs,
      checkpointer,
      resumeState: resumeState as RunAgentChatOptions['resumeState'],
      runTrace,
    }) as RunAgentChatOptions);
    templateMode.assertApplied(outcome.steps);
    if (controller && controller.signal.aborted) {
      status = 'cancelled';
      sse(response, 'cancelled', { runId, text: outcome.text, usage: outcome.usage });
    } else {
      // stepsExhausted=true 表示自动续跑到硬上限仍没做完 → 前端可提示"任务较大,已完成部分,可点继续"并携原 runId 续跑。
      sse(response, 'done', omitUndefined({ runId, text: outcome.text, steps: outcome.steps, usage: outcome.usage, stepsExhausted: outcome.stepsExhausted === true ? true : undefined, autoContinues: outcome.autoContinues }));
    }
  } catch (err) {
    status = 'failed';
    sse(response, 'error', { error: friendlyAgentError(err, requestContext), runId });
  } finally {
    finished = true;
    if (cancellation) cancellation.done(runId, requestContext);
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
    // 同样受记忆总闸约束:暂停/隐身/停用时不回写(与读缝一致)。
    if (memoryActive && status === 'succeeded' && outcome.text) {
      await maseRememberTurn(toolRegistry, String(body.prompt || ''), outcome.text, maseThread);
      // 自带对话缓冲:成功一轮的用户+助手写入本地缓冲(不依赖 MASE),供下一轮 session 层续接
      // (关闭 MASE 也有多轮记忆),并作为对话结束提炼主题知识(Phase 2)的短期来源。
      try {
        rememberBuiltinConversation(trustedRoot, maseConversation, String(body.prompt || ''), outcome.text, requestContext);
      } catch { /* 缓冲写入失败不阻断收尾 */ }
    }
    response.end();
  }
}
