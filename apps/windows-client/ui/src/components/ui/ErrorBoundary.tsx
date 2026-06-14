// ErrorBoundary(UI · components/ui 基础组件):React 错误边界——子树渲染抛错时兜底显示可读错误而非白屏,呼应「永不空交代」。
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './StateViews';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** 区域的人类可读标签,用于默认兜底标题。 */
  label?: string;
  /** 自定义兜底渲染,接收错误对象与重置回调。 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** 捕获错误时调用一次,常用于日志。 */
  onError?: (error: Error, info: ErrorInfo) => void;
}

export interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (typeof this.props.onError === 'function') {
      this.props.onError(error, info);
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(error, this.reset);
      }
      const title = this.props.label ? `${this.props.label} 出错了` : '出错了';
      return (
        <ErrorState
          title={title}
          message={error.message || '发生未知错误。'}
          onRetry={this.reset}
          retryLabel="重试"
        />
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
