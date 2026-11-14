import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from '@/components/ui/misc';

/** 页面代码块加载失败（通常是发布了新版本、旧的 chunk 已不存在），只能刷新整页 */
function isChunkError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.name === 'ChunkLoadError' || /Loading (CSS )?chunk|dynamically imported module|Importing a module script failed/i.test(error.message);
}

/**
 * 错误边界：子组件渲染出错时显示「页面出错了」与重试按钮，避免整页白屏。
 * resetKey 变化时清除错误，不卸载正常的页面或 Suspense 边界。
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: unknown; resetKey?: string }> {
  state: { error: unknown; resetKey?: string } = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { resetKey?: string }) {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  retry = () => {
    if (isChunkError(this.state.error)) window.location.reload();
    else this.setState({ error: null });
  };

  render() {
    if (this.state.error) return <ErrorState kind="render" error={this.state.error} onRetry={this.retry} />;
    return this.props.children;
  }
}
