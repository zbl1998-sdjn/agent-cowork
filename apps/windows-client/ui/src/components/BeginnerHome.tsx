import { Button } from './ui/Button';

export const BEGINNER_INPUT_FORMATS = ['Word', 'Excel', 'PPT', 'PDF', '图片', 'TXT', 'CSV', 'ZIP'];
export const BEGINNER_OUTPUT_FORMATS = ['Word', 'Excel', 'PPT', 'PDF', '可复制文本', 'CSV'];

export type BeginnerTask = {
  id: string;
  label: string;
  detail: string;
  outputs: string[];
};


export const BEGINNER_TASKS: BeginnerTask[] = [
  { id: 'weekly-report', label: '写周报', detail: '把本周流水账整理成正式周报。', outputs: ['Word', '可复制文本', 'PDF'] },
  { id: 'excel-rescue', label: '表格急救', detail: '检查重复、空值、异常金额和格式问题。', outputs: ['Excel', 'CSV', '文字结论'] },
  { id: 'word-formal', label: 'Word 改正式', detail: '把口语内容改成正式通知、说明或报告。', outputs: ['Word', 'PDF', '可复制文本'] },
  { id: 'office-rescue', label: 'Office 急救', detail: '不知道 Word、Excel、PPT 哪里出问题时，先按问题分类给方案。', outputs: ['修复建议', '副本', '草稿'] },
  { id: 'email-assistant', label: '写邮件/回复邮件', detail: '生成主题建议、礼貌正文和发送前检查清单。', outputs: ['邮件草稿', '主题建议', '可复制文本'] },
  { id: 'ppt-from-files', label: '做 PPT', detail: '从材料里提炼 6 到 10 页汇报结构和讲稿。', outputs: ['PPT', 'PDF', '讲稿'] },
  { id: 'meeting-minutes', label: '会议纪要', detail: '从会议记录或聊天记录提炼结论、待办和负责人。', outputs: ['Word', 'Excel 待办表', '群消息草稿'] },
  { id: 'boss-summary', label: '老板让我整理一下', detail: '先判断材料适合交付什么，再给 3 个可选方案。', outputs: ['一页总结', '汇总表', 'PPT'] },
  { id: 'unknown', label: '我也不知道该怎么弄', detail: '先看材料类型，再一步一步帮我选交付物。', outputs: ['推荐方案', '预览', '可保存成果'] },
];

export const BEGINNER_RECENT_DELIVERABLES = [
  { title: '周报草稿', formats: 'Word / PDF / 可复制文本', status: '可预览后保存' },
  { title: '表格清洗结论', formats: 'Excel / CSV / 文字结论', status: '原表不覆盖' },
  { title: '领导一页总结', formats: '一页总结 / PPT / TXT', status: '先生成草稿' },
  { title: '邮件回复草稿', formats: '主题建议 / 可复制正文 / Word', status: '人工确认后发送' },
];

export const BEGINNER_STEPS = ['选择任务', '放入材料', '生成草稿', '预览修改', '确认保存'];

const PRIMARY_TASK_IDS = new Set(['weekly-report', 'excel-rescue', 'ppt-from-files', 'meeting-minutes']);
const PRIMARY_TASKS = BEGINNER_TASKS.filter((task) => PRIMARY_TASK_IDS.has(task.id));
const SECONDARY_TASKS = BEGINNER_TASKS.filter((task) => !PRIMARY_TASK_IDS.has(task.id));


export function buildBeginnerTaskPrompt(task: BeginnerTask): string {
  return [
    `请按“小白办公模式”处理：${task.label}。`,
    `目标：${task.detail}`,
    `优先生成这些白领常用格式：${task.outputs.join('、')}。`,
    '规则：默认另存为副本，不覆盖原文件；每次只问一个问题；写入、发送、删除前必须让我确认。',
    '如果材料不够，请先给我一个可复制文本草稿和下一步选择。',
  ].join('\n');
}


interface BeginnerHomeProps {
  starters: string[];
  onQuickSend: (text: string) => void;
}

export function BeginnerHome({ starters, onQuickSend }: BeginnerHomeProps) {
  return (
    <div className="beginner-home" aria-label="小白办公首页">
      <section className="beginner-hero">
        <p className="beginner-kicker">本地办公助手</p>
        <h2>今天想完成什么？</h2>
        <p>直接说需求，或把文件拖入下方输入框。默认先生成草稿和副本，外发、覆盖、删除前会停下等你确认。</p>
      </section>

      <div className="beginner-quick-grid" aria-label="常用办公任务">
        {PRIMARY_TASKS.map((task) => (
          <Button
            key={task.id}
            variant="secondary"
            className="beginner-task beginner-task-quiet"
            onClick={() => onQuickSend(buildBeginnerTaskPrompt(task))}
          >
            <strong>{task.label}</strong>
            <span>{task.outputs.join(' / ')}</span>
          </Button>
        ))}
      </div>

      <div className="beginner-format-line" aria-label="支持放入的材料格式">
        支持 {BEGINNER_INPUT_FORMATS.join(' / ')}
      </div>

      <details className="beginner-more">
        <summary>更多办公模板</summary>
        <div className="beginner-task-grid" aria-label="更多办公任务">
          {SECONDARY_TASKS.map((task) => (
            <Button
              key={task.id}
              variant="secondary"
              className="beginner-task"
              onClick={() => onQuickSend(buildBeginnerTaskPrompt(task))}
            >
              <strong>{task.label}</strong>
              <span>{task.detail}</span>
              <em>{task.outputs.join(' / ')}</em>
            </Button>
          ))}
        </div>
      </details>

      {starters.length > 0 && (
        <details className="beginner-more beginner-examples" aria-label="新手示例">
          <summary>示例说法</summary>
          <div className="starter-chips">
            {starters.map((sug) => (
              <Button key={sug} className="starter-chip" onClick={() => onQuickSend(sug)}>{sug}</Button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
