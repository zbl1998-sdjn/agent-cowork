// 待确认操作状态(UI · hooks):把防重复提交、错误可见和按钮忙碌态集中到可复用 hook。
import { useCallback, useRef, useState } from 'react';
import { humanizeError } from '../lib/friendly-error';
import { createPendingActionGate } from '../lib/pending-action';

export function usePendingAction(action: string) {
  const gate = useRef<ReturnType<typeof createPendingActionGate>>();
  if (!gate.current) gate.current = createPendingActionGate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const run = useCallback(async (work: () => Promise<void>): Promise<boolean> => {
    const currentGate = gate.current;
    if (!currentGate || currentGate.isPending()) return false;
    setPending(true);
    setError('');
    try {
      return await currentGate.run(work);
    } catch (cause) {
      setError(humanizeError(cause, { action }));
      return false;
    } finally {
      setPending(false);
    }
  }, [action]);

  return { error, pending, run };
}
