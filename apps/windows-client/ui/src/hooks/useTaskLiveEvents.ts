// 任务实时动态(UI · hooks):attach 选中任务的 run 事件流(回放+实时),归约出时间线与
// 待审批清单,并提供在任务卡上直接批准/拒绝的动作。组件只渲染。
import { useCallback, useEffect, useState } from 'react';
import { respondApproval, subscribeRunEvents } from '../lib/api';
import { humanizeError } from '../lib/friendly-error';
import { initialTaskLiveState, reduceTaskLiveEvent, type TaskLiveState } from '../lib/task-live';

export type TaskLiveEvents = TaskLiveState & {
  streamError: string;
  respondBusy: string;
  respond: (approvalId: string, decision: 'once' | 'reject') => void;
};

export function useTaskLiveEvents(runId: string | null): TaskLiveEvents {
  const [state, setState] = useState<TaskLiveState>(initialTaskLiveState);
  const [streamError, setStreamError] = useState('');
  const [respondBusy, setRespondBusy] = useState('');

  useEffect(() => {
    setState(initialTaskLiveState());
    setStreamError('');
    setRespondBusy('');
    if (!runId) return undefined;
    return subscribeRunEvents(runId, (event) => {
      setState((current) => reduceTaskLiveEvent(current, event));
    }, {
      onError: (error) => setStreamError(humanizeError(error, { action: '订阅任务动态' })),
    });
  }, [runId]);

  const respond = useCallback((approvalId: string, decision: 'once' | 'reject') => {
    if (!approvalId) return;
    setRespondBusy(approvalId);
    setStreamError('');
    void respondApproval(approvalId, decision)
      .then((ok) => {
        if (!ok) setStreamError('审批提交失败,可能已过期或已在对话里处理。');
      })
      .catch((error) => setStreamError(humanizeError(error, { action: '提交审批' })))
      .finally(() => setRespondBusy(''));
  }, []);

  return { ...state, streamError, respondBusy, respond };
}
