// Memory DLP guard(host L1 memory).
// 职责:把长期记忆写入前的敏感分类集中化,避免凭据/高敏企业数据进入记忆。
import { classifyData } from '../security/data-classifier.js';

export type MemoryDlpDecision = {
  action: 'allow_auto_write' | 'deny_write';
  sensitivity: 'normal' | 'secret';
  reason: string;
  tags: string[];
};

export function decideMemoryDlp(input: { title?: unknown; content?: unknown; evidence?: unknown }): MemoryDlpDecision {
  const classification = classifyData({
    text: `${String(input.title || '')}\n${String(input.content || '')}\n${String(input.evidence || '')}`,
  });
  const tags = classification.tags.map((tag) => tag.kind);
  if (classification.sensitivity === 'restricted' || tags.includes('credential_secret')) {
    return {
      action: 'deny_write',
      sensitivity: 'secret',
      reason: '疑似 API key、token、密码或 Authorization 凭据，禁止写入长期记忆。',
      tags,
    };
  }
  return {
    action: 'allow_auto_write',
    sensitivity: 'normal',
    reason: '普通项目/偏好记忆，可自动写入。',
    tags,
  };
}

