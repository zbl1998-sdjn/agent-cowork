import type { Conversation } from './app-types';

export const GUEST_KEY = 'kcw.guest';
export const CONV_KEY = 'kcw.conversations.v1';
export const AUTO_CLARIFY_KEY = 'kcw.autoClarify';
export const STARTERS = [
  '整理工作区里的文档并列出清单',
  '把一个 CSV 文件做成图表',
  '总结这个文件夹里的会议纪要',
  '帮我起草一封邮件草稿',
];

let convSeq = 0;
export const nextConvId = () => 'c' + (convSeq += 1);
let branchSeq = 0;
export const nextBranchId = () => 'b' + (branchSeq += 1);
export const INITIAL_CONV = nextConvId();
export const PREVIEWABLE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|md|markdown|txt|text|log|csv|tsv|json|yaml|yml|xml|html?|pdf)$/i;

let messageSeq = 0;
export const nextMessageId = () => `m${(messageSeq += 1)}`;

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr as Conversation[];
    }
  } catch { /* ignore corrupt storage */ }
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
