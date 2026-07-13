// Office OOXML 文本工具(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:安全解码/转义 XML 文本，并在保留外围格式节点的前提下替换选定文本节点。
const ILLEGAL_XML_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function escapeOfficeXml(value: unknown): string {
  return String(value ?? '')
    .replace(ILLEGAL_XML_CONTROL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function decodeOfficeXml(value: unknown): string {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function escapedTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function textFromXmlTags(xml: string, tag: string): string {
  const safeTag = escapedTag(tag);
  return [...xml.matchAll(new RegExp(`<${safeTag}\\b[^>]*>([\\s\\S]*?)<\\/${safeTag}>`, 'g'))]
    .map((match) => decodeOfficeXml(match[1]))
    .join('');
}

export function replaceXmlTagText(xml: string, tag: string, value: string): string {
  const safeTag = escapedTag(tag);
  const pattern = new RegExp(`(<${safeTag}\\b)([^>]*>)([\\s\\S]*?)(<\\/${safeTag}>)`, 'g');
  let first = true;
  let found = false;
  const escaped = escapeOfficeXml(value);
  const preserve = /^\s|\s$/.test(value);
  const next = xml.replace(pattern, (_whole, start: string, attributes: string, _content: string, end: string) => {
    found = true;
    const nextAttributes = preserve && first && !/\bxml:space=/.test(attributes)
      ? attributes.replace(/>$/, ' xml:space="preserve">')
      : attributes;
    const content = first ? escaped : '';
    first = false;
    return `${start}${nextAttributes}${content}${end}`;
  });
  if (!found) throw new Error(`Editable XML text node <${tag}> was not found`);
  return next;
}

export function naturalPartOrder(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}
