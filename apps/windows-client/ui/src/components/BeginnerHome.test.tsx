import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BEGINNER_TASKS, BeginnerHome, buildBeginnerTaskPrompt } from './BeginnerHome';

describe('BeginnerHome', () => {
  it('renders daily office tasks and common office formats without expert terms', () => {
    const html = renderToStaticMarkup(<BeginnerHome starters={['帮我把这些表格合并成一个总表']} onQuickSend={vi.fn()} />);

    expect(html).toContain('今天想完成什么');
    expect(html).toContain('把文件拖入下方输入框');
    expect(html).toContain('更多办公模板');
    expect(html).toContain('Word');
    expect(html).toContain('Excel');
    expect(html).toContain('PPT');
    expect(html).toContain('PDF');
    expect(html).toContain('CSV');
    expect(html).toContain('可复制文本');
    expect(html).toContain('老板让我整理一下');
    expect(html).toContain('Office 急救');
    expect(html).toContain('写邮件/回复邮件');
    expect(html).toContain('发送前检查清单');
    expect(html).not.toContain('一步一步来');
    expect(html).not.toContain('确认保存');
    expect(html).not.toContain('常见交付结果');
    expect(html).not.toContain('MCP');
    expect(html).not.toContain('Provider');
    expect(html).not.toContain('Model Router');
    expect(html).not.toContain('Token');
    expect(html).not.toContain('Shell');
    expect(html).not.toContain('Workspace Root');
  });

  it('builds beginner prompts that request copy-first common deliverables', () => {
    const weekly = BEGINNER_TASKS.find((task) => task.id === 'weekly-report');
    expect(weekly).toBeTruthy();

    const prompt = buildBeginnerTaskPrompt(weekly!);
    expect(prompt).toContain('小白办公模式');
    expect(prompt).toContain('Word、可复制文本、PDF');
    expect(prompt).toContain('默认另存为副本');
    expect(prompt).toContain('不覆盖原文件');
    expect(prompt).toContain('每次只问一个问题');
  });

  it('builds an email assistant prompt that keeps sending under user confirmation', () => {
    const email = BEGINNER_TASKS.find((task) => task.id === 'email-assistant');
    expect(email).toBeTruthy();

    const prompt = buildBeginnerTaskPrompt(email!);
    expect(prompt).toContain('邮件草稿、主题建议、可复制文本');
    expect(prompt).toContain('写入、发送、删除前必须让我确认');
  });

});
