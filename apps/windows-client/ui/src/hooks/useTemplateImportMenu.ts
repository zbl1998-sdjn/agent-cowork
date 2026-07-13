import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export function nextTemplateMenuIndex(key: string, currentIndex: number, itemCount: number): number | null {
  if (itemCount <= 0) return null;
  if (key === 'ArrowDown') return (currentIndex + 1) % itemCount;
  if (key === 'ArrowUp') return (currentIndex - 1 + itemCount) % itemCount;
  if (key === 'Home') return 0;
  if (key === 'End') return itemCount - 1;
  return null;
}

export function useTemplateImportMenu(itemCount: number) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusIndexRef = useRef(0);
  const [menuOpen, setMenuOpen] = useState(false);

  const focusMenuItem = (index: number) => {
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    items?.[index]?.focus();
  };

  const focusTrigger = () => {
    rootRef.current?.querySelector<HTMLButtonElement>('.template-upload-button')?.focus();
  };

  const focusComposer = () => {
    rootRef.current?.closest('.composer-dock')?.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
  };

  const openMenu = (focusIndex: number) => {
    pendingFocusIndexRef.current = focusIndex;
    setMenuOpen(true);
  };

  const closeMenu = (restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) window.requestAnimationFrame(focusTrigger);
  };

  useEffect(() => {
    if (!menuOpen) return;
    const frame = window.requestAnimationFrame(() => focusMenuItem(pendingFocusIndexRef.current));
    return () => window.cancelAnimationFrame(frame);
  }, [menuOpen]);

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMenu(0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu(itemCount - 1);
    } else if (event.key === 'Escape' && menuOpen) {
      event.preventDefault();
      closeMenu(true);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      setMenuOpen(false);
      window.requestAnimationFrame(event.shiftKey ? focusTrigger : focusComposer);
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || []);
    const currentIndex = Math.max(0, items.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex = nextTemplateMenuIndex(event.key, currentIndex, items.length);
    if (nextIndex === null) return;
    event.preventDefault();
    focusMenuItem(nextIndex);
  };

  return { rootRef, menuRef, menuOpen, openMenu, closeMenu, onTriggerKeyDown, onMenuKeyDown };
}
