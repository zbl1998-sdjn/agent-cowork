// ErrorBoundary(UI · components/ui 基础组件):React 错误边界——子树渲染抛错时兜底显示可读错误而非白屏,呼应「永不空交代」。
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './StateViews';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Human label for the region, shown in the default fallback title. */
  label?: string;
  /** Custom fallback; receives the error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Called once when an error is caught (e.g. for logging). */
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
