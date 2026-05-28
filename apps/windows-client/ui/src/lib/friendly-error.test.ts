import { describe, expect, it } from 'vitest';
import { humanizeError } from './friendly-error';

describe('humanizeError', () => {
  it('maps ECONNREFUSED to host-not-running guidance', () => {
    expect(humanizeError(new Error('connect ECONNREFUSED 127.0.0.1:51873'))).toContain('Agent Cowork 后台');
  });

  it('maps 401 to login/api-key guidance', () => {
    expect(humanizeError(new Error('HTTP 401 Unauthorized'))).toContain('重新登录');
  });

  it('maps 404 to resource-not-found guidance', () => {
    expect(humanizeError(new Error('Request failed with status 404'))).toContain('找不到');
  });

  it('maps 429 to rate-limit guidance', () => {
    expect(humanizeError(new Error('429 Too Many Requests'))).toContain('稍等');
  });

  it('maps 5xx to backend-error guidance', () => {
    expect(humanizeError(new Error('HTTP 500 Internal Server Error'))).toContain('后端服务');
  });

  it('maps JSON parse errors to API-misrouted guidance', () => {
    expect(humanizeError(new Error("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON")))
      .toContain('不是合法 JSON');
  });

  it('maps timeout to retry guidance', () => {
    expect(humanizeError(new Error('ETIMEDOUT'))).toContain('请求超时');
  });

  it('handles AbortError', () => {
    expect(humanizeError(new Error('The user aborted a request.'))).toContain('取消');
  });

  it('falls back to raw message with action prefix when no mapping matches', () => {
    expect(humanizeError(new Error('something custom went wrong'), { action: '保存' }))
      .toBe('保存失败:something custom went wrong');
  });

  it('falls back to raw message without prefix when no action given', () => {
    expect(humanizeError(new Error('something custom went wrong')))
      .toBe('something custom went wrong');
  });

  it('handles string inputs', () => {
    expect(humanizeError('ECONNREFUSED on socket')).toContain('Agent Cowork 后台');
  });

  it('handles null/undefined without crashing', () => {
    expect(humanizeError(null)).toContain('没有错误信息');
    expect(humanizeError(undefined, { action: '保存' })).toBe('保存失败,但没有错误信息');
  });

  it('caps very long raw messages', () => {
    const huge = 'x'.repeat(500);
    const result = humanizeError(new Error(huge));
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.endsWith('…')).toBe(true);
  });

  it('handles plain objects', () => {
    expect(humanizeError({ message: 'HTTP 403 Forbidden' })).toContain('没有该操作的权限');
  });
});
