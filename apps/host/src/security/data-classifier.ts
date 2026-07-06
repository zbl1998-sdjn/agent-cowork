// 数据分级标签(host L0 security).
// 职责:对即将进入模型/网络/记忆的文本做轻量规则分类,只返回标签和级别,不暴露原文。
import { redactText } from './redaction.js';

export type DataSensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
export type DataTagKind =
  | 'credential_secret'
  | 'personal_information'
  | 'financial'
  | 'hr'
  | 'customer_data'
  | 'source_code'
  | 'contract'
  | 'legal'
  | 'strategy'
  | 'meeting'
  | 'unknown';

export type DataTag = {
  kind: DataTagKind;
  label: string;
  sensitivity: DataSensitivity;
  reasonCode: string;
};

export type DataClassification = {
  sensitivity: DataSensitivity;
  tags: DataTag[];
  byteLength: number;
  redactionApplied: boolean;
  allowCloudByDefault: boolean;
};

type Rule = DataTag & { pattern: RegExp };

const RULES: readonly Rule[] = [
  { kind: 'credential_secret', label: 'Credential / Secret', sensitivity: 'restricted', reasonCode: 'secret_pattern', pattern: /\b(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization|bearer)\b|sk-[A-Za-z0-9][A-Za-z0-9._-]{9,}/i },
  { kind: 'personal_information', label: 'Personal Information', sensitivity: 'confidential', reasonCode: 'pii_pattern', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:手机号|身份证|护照|住址|家庭地址|phone|email|address)\b/i },
  { kind: 'financial', label: 'Financial Data', sensitivity: 'confidential', reasonCode: 'finance_pattern', pattern: /\b(?:invoice|bank|accounting|revenue|payroll|tax|发票|银行|工资|营收|财务|税务)\b/i },
  { kind: 'hr', label: 'HR Data', sensitivity: 'confidential', reasonCode: 'hr_pattern', pattern: /\b(?:offer|salary|performance review|employee|候选人|员工|绩效|薪资|劳动合同)\b/i },
  { kind: 'customer_data', label: 'Customer Data', sensitivity: 'confidential', reasonCode: 'customer_pattern', pattern: /\b(?:customer|client|crm|contractor|客户|客户名单|联系人|客诉)\b/i },
  { kind: 'source_code', label: 'Source Code', sensitivity: 'internal', reasonCode: 'source_code_pattern', pattern: /\b(?:function|class|interface|import|export|package\.json|Cargo\.toml|pyproject\.toml|源码|代码)\b/i },
  { kind: 'contract', label: 'Contract', sensitivity: 'confidential', reasonCode: 'contract_pattern', pattern: /\b(?:contract|nda|agreement|clause|合同|协议|保密协议|条款)\b/i },
  { kind: 'legal', label: 'Legal', sensitivity: 'confidential', reasonCode: 'legal_pattern', pattern: /\b(?:legal|lawsuit|compliance|policy|法务|诉讼|合规|监管)\b/i },
  { kind: 'strategy', label: 'Business Strategy', sensitivity: 'confidential', reasonCode: 'strategy_pattern', pattern: /\b(?:strategy|roadmap|pricing|merger|acquisition|战略|路线图|定价|并购)\b/i },
  { kind: 'meeting', label: 'Meeting Notes', sensitivity: 'internal', reasonCode: 'meeting_pattern', pattern: /\b(?:meeting|minutes|action item|会议|纪要|待办)\b/i },
];

const SENSITIVITY_RANK: Record<DataSensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

function textFrom(input: { text?: unknown; path?: unknown; fileName?: unknown } = {}): string {
  return [input.fileName, input.path, input.text].map((item) => String(item || '')).filter(Boolean).join('\n');
}

function maxSensitivity(tags: readonly DataTag[]): DataSensitivity {
  let sensitivity: DataSensitivity = 'public';
  for (const tag of tags) {
    if (SENSITIVITY_RANK[tag.sensitivity] > SENSITIVITY_RANK[sensitivity]) sensitivity = tag.sensitivity;
  }
  return sensitivity;
}

export function classifyData(input: { text?: unknown; path?: unknown; fileName?: unknown } = {}): DataClassification {
  const text = textFrom(input);
  const tags = RULES.filter((rule) => rule.pattern.test(text)).map(({ pattern: _pattern, ...tag }) => tag);
  const unique = new Map(tags.map((tag) => [tag.kind, tag]));
  const finalTags = [...unique.values()];
  if (!finalTags.length && text.trim()) {
    finalTags.push({ kind: 'unknown', label: 'Unclassified Local Content', sensitivity: 'internal', reasonCode: 'non_empty_content' });
  }
  const sensitivity = maxSensitivity(finalTags);
  return {
    sensitivity,
    tags: finalTags,
    byteLength: Buffer.byteLength(text, 'utf8'),
    redactionApplied: redactText(text) !== text,
    allowCloudByDefault: sensitivity === 'public' || sensitivity === 'internal',
  };
}

