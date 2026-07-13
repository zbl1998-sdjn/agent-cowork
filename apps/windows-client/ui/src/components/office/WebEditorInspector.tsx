import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

import type {
  WebElementSelection,
  WebInsertPlacement,
  WebInsertPreset,
  WebStructureAction,
} from '../../lib/types/webEditor';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

const INSERT_ITEMS: ReadonlyArray<Readonly<{ preset: WebInsertPreset; label: string }>> = [
  { preset: 'heading', label: '标题' },
  { preset: 'text', label: '正文' },
  { preset: 'button', label: '按钮' },
  { preset: 'image', label: '图片' },
  { preset: 'section', label: '内容区' },
  { preset: 'columns', label: '双栏布局' },
];

export function selectionPatchFromDraft(
  selection: WebElementSelection,
  draft: WebElementSelection,
  key: keyof WebElementSelection,
): Partial<WebElementSelection> | null {
  if (draft[key] === selection[key]) return null;
  return { [key]: draft[key] } as Partial<WebElementSelection>;
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<Readonly<{ value: string; label: string }>>;
  onChange: (value: string) => void;
}) {
  const resolvedOptions = options.some((option) => option.value === value)
    ? options
    : [{ value, label: `当前：${value || '默认'}` }, ...options];
  return (
    <label>{label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {resolvedOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

export function WebEditorInspector({
  selection,
  onUpdate,
  onAction,
  onInsert,
}: {
  selection: WebElementSelection;
  onUpdate: (patch: Partial<WebElementSelection>) => void;
  onAction: (action: WebStructureAction) => void;
  onInsert: (preset: WebInsertPreset, placement: WebInsertPlacement) => void;
}) {
  const [placement, setPlacement] = useState<WebInsertPlacement>('after');
  const [draft, setDraft] = useState(selection);
  const draftRef = useRef(selection);
  useEffect(() => {
    draftRef.current = selection;
    setDraft(selection);
  }, [selection]);
  const edit = (key: keyof WebElementSelection) => (value: string) => {
    const next = { ...draftRef.current, [key]: value };
    draftRef.current = next;
    setDraft(next);
  };
  const apply = (key: keyof WebElementSelection) => () => {
    const patch = selectionPatchFromDraft(selection, draftRef.current, key);
    if (patch) onUpdate(patch);
  };
  const choose = (key: keyof WebElementSelection) => (value: string) => {
    edit(key)(value);
    onUpdate({ [key]: value });
  };
  const field = (key: keyof WebElementSelection) => ({
    value: String(draft[key]),
    onChange: (event: ChangeEvent<HTMLInputElement>) => edit(key)(event.target.value),
    onBlur: apply(key),
  });
  const isLink = selection.tag === 'a';
  const isImage = selection.tag === 'img';

  return (
    <div className="web-editor-inspector">
      <div className="web-selection-card">
        <code>&lt;{selection.tag}&gt;</code>
        <div><strong>{selection.label}</strong><span>高级组件编辑</span></div>
      </div>

      <details open>
        <summary>内容与属性</summary>
        <div className="web-inspector-section">
          <label>文字
            <textarea
              value={draft.text}
              disabled={!selection.canEditText}
              onChange={(event) => {
                edit('text')(event.target.value);
                onUpdate({ text: event.target.value });
              }}
            />
          </label>
          {!selection.canEditText && <small>该容器包含子组件，请在左侧结构中选择具体文字。</small>}
          <Input label="CSS 类名" {...field('className')} />
          {isLink && <>
            <Input label="链接地址" {...field('href')} />
            <SelectField label="打开方式" value={draft.target || '_self'} options={[
              { value: '_self', label: '当前页面' }, { value: '_blank', label: '新窗口' },
            ]} onChange={choose('target')} />
          </>}
          {isImage && <>
            <Input label="图片地址" {...field('src')} />
            <Input label="替代文字" {...field('alt')} />
          </>}
        </div>
      </details>

      <details open>
        <summary>尺寸与间距</summary>
        <div className="web-inspector-section web-inspector-grid">
          <Input label="宽度" {...field('width')} />
          <Input label="高度" {...field('height')} />
          <Input label="内边距" {...field('padding')} />
          <Input label="外边距" {...field('margin')} />
          <Input label="元素间距" {...field('gap')} />
          <Input label="圆角" {...field('borderRadius')} />
        </div>
      </details>

      <details>
        <summary>布局与外观</summary>
        <div className="web-inspector-section">
          <SelectField label="布局方式" value={draft.display} options={[
            { value: 'block', label: '块级' }, { value: 'inline', label: '行内' },
            { value: 'inline-block', label: '行内块' }, { value: 'flex', label: '弹性布局' },
            { value: 'inline-flex', label: '行内弹性' },
            { value: 'grid', label: '网格布局' }, { value: 'none', label: '隐藏' },
          ]} onChange={choose('display')} />
          {(draft.display === 'flex' || draft.display === 'inline-flex') && <div className="web-inspector-grid">
            <SelectField label="排列方向" value={draft.flexDirection} options={[
              { value: 'row', label: '横向' }, { value: 'column', label: '纵向' },
            ]} onChange={choose('flexDirection')} />
            <SelectField label="主轴对齐" value={draft.justifyContent} options={[
              { value: 'flex-start', label: '起点' }, { value: 'center', label: '居中' },
              { value: 'space-between', label: '两端' }, { value: 'flex-end', label: '终点' },
            ]} onChange={choose('justifyContent')} />
            <SelectField label="交叉轴对齐" value={draft.alignItems} options={[
              { value: 'stretch', label: '拉伸' }, { value: 'flex-start', label: '起点' },
              { value: 'center', label: '居中' }, { value: 'flex-end', label: '终点' },
            ]} onChange={choose('alignItems')} />
          </div>}
          <div className="web-inspector-grid">
            <Input label="文字颜色" {...field('color')} />
            <Input label="背景颜色" {...field('backgroundColor')} />
            <Input label="字号" {...field('fontSize')} />
            <Input label="边框" {...field('border')} />
          </div>
          <SelectField label="文字对齐" value={draft.textAlign} options={[
            { value: 'start', label: '自动' }, { value: 'left', label: '左对齐' },
            { value: 'center', label: '居中' }, { value: 'right', label: '右对齐' },
          ]} onChange={choose('textAlign')} />
        </div>
      </details>

      <details open>
        <summary>插入组件</summary>
        <div className="web-inspector-section">
          <div className="web-placement-toggle" aria-label="插入位置">
            <button type="button" className={placement === 'after' ? 'is-active' : ''} onClick={() => setPlacement('after')}>放在后面</button>
            <button type="button" className={placement === 'inside' ? 'is-active' : ''} onClick={() => setPlacement('inside')}>放在里面</button>
          </div>
          <div className="web-insert-palette">
            {INSERT_ITEMS.map((item) => (
              <button key={item.preset} type="button" onClick={() => onInsert(item.preset, placement)}>{item.label}</button>
            ))}
          </div>
        </div>
      </details>

      <div className="web-structure-actions" aria-label="组件结构操作">
        <Button size="sm" variant="ghost" onClick={() => onAction('move-up')}>上移</Button>
        <Button size="sm" variant="ghost" onClick={() => onAction('move-down')}>下移</Button>
        <Button size="sm" variant="secondary" onClick={() => onAction('duplicate')}>复制组件</Button>
        <Button size="sm" variant="danger" onClick={() => onAction('delete')}>删除</Button>
        <small>结构操作均可撤销，保存前不会修改原文件。</small>
      </div>
    </div>
  );
}
