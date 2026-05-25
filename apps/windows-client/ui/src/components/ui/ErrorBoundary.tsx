import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from './StateViews';

// React error boundary (FE-3). Wraps the main area and each panel so a render
// crash in one region shows a readable, retryable fallback instead of a white
// screen. Pass `label` to name the failed region, `fallback` for a custom view,
// and `onError` to log. Reset clears the error and re-renders children.

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
