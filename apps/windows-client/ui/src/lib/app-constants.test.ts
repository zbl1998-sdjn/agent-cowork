import { describe, expect, it, vi } from 'vitest';

// conversationId 会进 MASE 记忆线程(thread_id 含 conversationId)并持久化到 localStorage;
// messageId 持久化在会话消息里。两者都必须跨「页面加载」全局唯一:
// 短自增(c1/c2、m1/m2)每次加载从 0 重计,新窗口会与历史会话/消息撞 id——
// 后果是 MASE 线程串台(别的窗口的记忆混入)与 patchAssistant 改中两条消息(双渲染)。
describe('id generators are unique across page loads', () => {
  async function freshModule() {
    vi.resetModules();
    return await import('./app-constants');
  }

  it('nextConvId never repeats across two simulated page loads', async () => {
    const first = await freshModule();
    const idsA = new Set([first.INITIAL_CONV, first.nextConvId(), first.nextConvId()]);
    const second = await freshModule();
    const idsB = [second.INITIAL_CONV, second.nextConvId(), second.nextConvId()];
    for (const id of idsB) {
      expect(idsA.has(id), `conv id ${id} collided across reloads`).toBe(false);
    }
  });

  it('nextMessageId never repeats across two simulated page loads', async () => {
    const first = await freshModule();
    const idsA = new Set([first.nextMessageId(), first.nextMessageId(), first.nextMessageId()]);
    const second = await freshModule();
    for (let i = 0; i < 3; i += 1) {
      const id = second.nextMessageId();
      expect(idsA.has(id), `message id ${id} collided across reloads`).toBe(false);
    }
  });

  it('ids stay unique within one load and keep their prefixes', async () => {
    const mod = await freshModule();
    const conv = new Set<string>();
    const msg = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      conv.add(mod.nextConvId());
      msg.add(mod.nextMessageId());
    }
    expect(conv.size).toBe(200);
    expect(msg.size).toBe(200);
    for (const id of conv) expect(id.startsWith('c')).toBe(true);
    for (const id of msg) expect(id.startsWith('m')).toBe(true);
  });
});
