// 应用常量(UI · lib):集中存放界面默认值/限额/初始会话等常量(配置而非硬编码,plan/01 B.7)。
import type { Conversation } from './app-types';

export const GUEST_KEY = 'acw.guest';
export const CONV_KEY = 'acw.conversations.v1'; // gitleaks:allow -- public localStorage key
export const AUTO_CLARIFY_KEY = 'acw.autoClarify';
export const AUTO_CONTEXT_COMPACTION_KEY = 'acw.autoContextCompaction';
export const STARTERS = [
  '整理工作区里的文档并列出清单',
  '把一个 CSV 文件做成图表',
  '总结这个文件夹里的会议纪要',
  '帮我起草一封邮件草稿',
  '把这段内容改成一封礼貌的跟进邮件',
];

// id 必须跨「页面加载」全局唯一,不能用加载内自增(c1/c2、m1/m2):
// conversationId 进 MASE 记忆线程(thread_id 含它)并持久化——撞 id 会让不同时期的
// 窗口共享同一记忆线程(别的对话的内容串进来);messageId 持久化在会话消息里——
// reload 后撞 id 会让 patchAssistant/React key 同时命中历史消息(回复被覆盖/双渲染)。
// 形如 <epoch36>-<seq><rand>:时间戳保跨加载唯一,序号+随机保同毫秒内唯一。
let idSeq = 0;
function uniqueId(prefix: string): string {
  idSeq += 1;
  return `${prefix}${Date.now().toString(36)}-${idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
export const nextConvId = () => uniqueId('c');
export const nextBranchId = () => uniqueId('b');
export const INITIAL_CONV = nextConvId();
export const PREVIEWABLE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|md|markdown|txt|text|log|csv|tsv|json|yaml|yml|xml|html?|pdf)$/i;

export const nextMessageId = () => uniqueId('m');

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr as Conversation[];
    }
  } catch { /* 本地存储损坏时忽略并回到新会话 */ }
  return [{ id: INITIAL_CONV, title: '新对话', messages: [] }];
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
