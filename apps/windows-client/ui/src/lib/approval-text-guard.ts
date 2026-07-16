// approval-text-guard(UI · lib 纯逻辑层)
// ---------------------------------------------------------------------------
// 职责:把审批预览文本中的不可见方向控制字符可见化,防止工具参数用
//       bidi 覆盖(RLO/LRO/isolate)或零宽字符在视觉上重排/隐藏审批内容,
//       让用户批准与真实字节不符的操作。只处理不可见字符;全角引号、
//       CJK 标点等可见字符属正文,不改写。纯函数,无副作用。
// 权衡:ZWJ/ZWNJ 也会被可见化,因此组合 emoji(如家庭 emoji)在审批预览里
//       会显示成转义序列——安全预览以"所见即字节"优先于美观。
// 说明:码位与转义均从数字构造,避免源码里出现原始不可见字符。

// U+00AD 软连字符;U+061C 阿拉伯字母标记;U+200B-U+200F 零宽系 + LRM/RLM;
// U+202A-U+202E 嵌入/覆盖控制;U+2060 词连接符;U+2066-U+2069 隔离控制;U+FEFF BOM。
const INVISIBLE_CODEPOINTS: readonly number[] = [
  0x00ad, 0x061c,
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2060, 0x2066, 0x2067, 0x2068, 0x2069,
  0xfeff,
];

const INVISIBLE_DIRECTIVES = new RegExp(
  '[' + INVISIBLE_CODEPOINTS.map((cp) => String.fromCharCode(cp)).join('') + ']',
  'g',
);

const BACKSLASH = String.fromCharCode(0x5c);

function toVisibleEscape(char: string): string {
  return BACKSLASH + 'u' + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
}

export function neutralizeInvisibleDirectives(text: string): string {
  return text.replace(INVISIBLE_DIRECTIVES, toVisibleEscape);
}
