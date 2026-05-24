import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const DEFAULT_THRESHOLD_PX = 48;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface UseStickToBottomOptions {
  thresholdPx?: number;
}

export function isNearBottom(metrics: ScrollMetrics, thresholdPx = DEFAULT_THRESHOLD_PX): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= thresholdPx;
}

export function shouldFlagNewContent(wasAtBottom: boolean, previousScrollHeight: number, nextScrollHeight: number): boolean {
  return !wasAtBottom && nextScrollHeight > previousScrollHeight + 1;
}

export function shouldResetScroll(lastResetKey: unknown, resetKey: unknown, previousScrollHeight: number): boolean {
  return lastResetKey !== resetKey || previousScrollHeight <= 0;
}

function forceBottom(el: HTMLElement, previousHeightRef: { current: number }) {
  previousHeightRef.current = el.scrollHeight;
  el.scrollTop = el.scrollHeight;
}

export function useStickToBottom(
  contentVersion: unknown,
  resetKey: unknown,
  options: UseStickToBottomOptions = {},
) {
  const thresholdPx = options.thresholdPx ?? DEFAULT_THRESHOLD_PX;
  const containerRef = useRef<HTMLElement | null>(null);
  const stickRef = useRef(true);
  const previousHeightRef = useRef(0);
  const lastResetKeyRef = useRef<unknown>(undefined);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewContent, setHasNewContent] = useState(false);

  const updateStickState = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const nextIsAtBottom = isNearBottom(el, thresholdPx);
    stickRef.current = nextIsAtBottom;
    setIsAtBottom(nextIsAtBottom);
    if (nextIsAtBottom) setHasNewContent(false);
  }, [thresholdPx]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = containerRef.current;
    if (!el) return;
    const top = el.scrollHeight;
    try {
      el.scrollTo({ top, behavior });
    } catch {
      el.scrollTop = top;
    }
    if (behavior === 'smooth') {
      setTimeout(() => {
        if (!isNearBottom(el, thresholdPx)) el.scrollTop = el.scrollHeight;
      }, 650);
    }
    stickRef.current = true;
    setIsAtBottom(true);
    setHasNewContent(false);
  }, [thresholdPx]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    updateStickState();
    el.addEventListener('scroll', updateStickState, { passive: true });
    return () => el.removeEventListener('scroll', updateStickState);
  });

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!shouldResetScroll(lastResetKeyRef.current, resetKey, previousHeightRef.current)) return;
    lastResetKeyRef.current = resetKey;
    stickRef.current = true;
    forceBottom(el, previousHeightRef);
    if (typeof requestAnimationFrame === 'function') {
      const settlingResetKey = resetKey;
      const startedAt = Date.now();
      const settle = () => {
        if (lastResetKeyRef.current !== settlingResetKey) return;
        stickRef.current = true;
        forceBottom(el, previousHeightRef);
        setIsAtBottom(true);
        setHasNewContent(false);
        if (Date.now() - startedAt < 650) requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
    }
    setIsAtBottom(true);
    setHasNewContent(false);
  });

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const previousHeight = previousHeightRef.current;
    const nextHeight = el.scrollHeight;
    const wasAtBottom = stickRef.current || previousHeight === 0;
    previousHeightRef.current = nextHeight;

    if (wasAtBottom) {
      el.scrollTop = el.scrollHeight;
      stickRef.current = true;
      setIsAtBottom(true);
      setHasNewContent(false);
      return;
    }

    if (shouldFlagNewContent(false, previousHeight, nextHeight)) {
      setHasNewContent(true);
    }
    setIsAtBottom(isNearBottom(el, thresholdPx));
  }, [contentVersion, thresholdPx]);

  return { containerRef, isAtBottom, hasNewContent, scrollToBottom };
}
