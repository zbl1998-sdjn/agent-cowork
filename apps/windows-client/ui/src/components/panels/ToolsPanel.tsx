import { useState } from 'react';
import { searchTools, callTool, type ToolDescriptor, type SubagentStep } from '../../lib/api';
import { Button } from '../ui/Button';
import { Empty, ErrorState } from '../ui/StateViews';

interface ToolsPanelProps {
  trustedRoot: string;
  onRunPlan?: (goal: string, steps: SubagentStep[]) => void;
}

export function ToolsPanelEmptyState() {
  return <Empty title="输入关键字搜索工具" message="匹配到的可用工具会显示在这里。" />;
}

export function isToolPanelErrorResult(result: string): boolean {
  return result.startsWith('错误：') || result.startsWith('参数 JSON 无效：');
}

export function ToolsPanelResultState({ result }: { result: string }) {
  if (!result) return null;
  if (isToolPanelErrorResult(result)) {
    const title = result.startsWith('参数 JSON 无效：') ? '参数 JSON 无效' : '工具调用失败';
    const message = result.replace(/^错误：/, '').replace(/^参数 JSON 无效：/, '');
    return <ErrorState title={title} message={message} />;
  }
  return <pre className="panel-result">{result}</pre>;
}

export function ToolsPanelCallActions({
  busy,
  selectedRequiresApproval,
  onCall,
  onAddStep,
}: {
  busy: boolean;
  selectedRequiresApproval: boolean;
  onCall: () => void;
  onAddStep: () => void;
}) {
  return (
    <div className="panel-row">
      <Button variant="secondary" disabled={busy || selectedRequiresApproval} onClick={onCall}>{busy ? '调用中…' : '调用'}</Button>
      <Button variant="secondary" disabled={selectedRequiresApproval} onClick={onAddStep}>加入计划</Button>
    </div>
  );
}

export function ToolsPanelPlanActions({ onRun, onClear }: { onRun: () => void; onClear: () => void }) {
  return (
    <div className="panel-row">
      <Button variant="secondary" onClick={onRun}>运行子任务</Button>
      <Button variant="secondary" onClick={onClear}>清空</Button>
    </div>
  );
}

// Tool discovery + ad-hoc invocation + a sub-agent plan builder. Mirrors the
// host's lazy ToolSearch: search by keyword, pick a tool, call it directly, or
// stack several calls into a plan and run them as one sub-agent.
export function ToolsPanel({ trustedRoot, onRunPlan }: ToolsPanelProps) {
  const [query, setQuery] = useState('');
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  const [selected, setSelected] = useState('');
  const [argsText, setArgsText] = useState('{}');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<SubagentStep[]>([]);
  const [goal, setGoal] = useState('');

  const parseArgs = (): Record<string, unknown> => (argsText.trim() ? (JSON.parse(argsText) as Record<string, unknown>) : {});
  const selectedTool = tools.find((tool) => tool.name === selected);
  const selectedRequiresApproval = selectedTool?.requiresApproval === true || selectedTool?.mutating === true || selectedTool?.risk === 'high' || selectedTool?.risk === 'critical';

  const onSearch = async () => {
    try {
      setTools(await searchTools(query, 12));
    } catch (error) {
      setResult(`错误：${(error as Error).message}`);
    }
  };

  const onCall = async () => {
    if (!selected) return;
    setBusy(true);
    setResult('');
    try {
      const res = await callTool(selected, parseArgs(), trustedRoot);
      setResult(JSON.stringify(res.result, null, 2));
    } catch (error) {
      setResult(`错误：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onAddStep = () => {
    if (!selected) return;
    try {
      setPlan((steps) => [...steps, { tool: selected, args: parseArgs() }]);
    } catch (error) {
      setResult(`参数 JSON 无效：${(error as Error).message}`);
    }
  };

  const onRun = () => {
    if (plan.length && onRunPlan) {
      onRunPlan(goal, plan);
      setPlan([]);
      setGoal('');
    }
  };

  return (
    <section className="side-panel">
      <h2>工具</h2>
      <div className="panel-row">
        <input
          value={query}
          placeholder="搜索工具（懒加载）"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void onSearch(); }}
        />
        <Button variant="secondary" onClick={() => void onSearch()}>搜索</Button>
      </div>
      <ul className="tool-list">
        {tools.map((tool) => (
          <li
            key={tool.name}
            className={tool.name === selected ? 'is-selected' : ''}
            onClick={() => setSelected(tool.name)}
          >
            <code>{tool.name}</code>
            <span className="tool-src">{tool.source}</span>
            <p>{tool.description}</p>
          </li>
        ))}
        {tools.length === 0 && (
          <li className="panel-empty">
            <ToolsPanelEmptyState />
          </li>
        )}
      </ul>
      {selected && (
        <div className="panel-call">
          <label>调用 <code>{selected}</code> · 参数 (JSON)</label>
          <textarea value={argsText} rows={3} spellCheck={false} onChange={(e) => setArgsText(e.target.value)} />
          <ToolsPanelCallActions
            busy={busy}
            selectedRequiresApproval={selectedRequiresApproval}
            onCall={() => void onCall()}
            onAddStep={onAddStep}
          />
          {selectedRequiresApproval && <p className="panel-note">该工具需经 Agent 审批流执行。</p>}
          <ToolsPanelResultState result={result} />
        </div>
      )}
      {plan.length > 0 && (
        <div className="panel-plan">
          <label>子任务计划 ({plan.length} 步)</label>
          <ol>
            {plan.map((step, i) => (
              <li key={i}><code>{step.tool}</code></li>
            ))}
          </ol>
          <input value={goal} placeholder="子任务目标（可选）" onChange={(e) => setGoal(e.target.value)} />
          <ToolsPanelPlanActions onRun={onRun} onClear={() => setPlan([])} />
        </div>
      )}
    </section>
  );
}
