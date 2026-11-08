import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorState } from '@/components/ui/misc';

/** 页面代码块加载失败（通常是发布了新版本、旧的 chunk 已不存在），只能刷新整页 */
function isChunkError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.name === 'ChunkLoadError' || /Loading (CSS )?chunk|dynamically imported module|Importing a module script failed/i.test(error.message);
}

/**
 * 错误边界：子组件渲染出错时显示「页面出错了」与重试按钮，避免整页白屏。
 * 外层通过 key 在切换页面或标签页时重置。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state: { error: unknown } = { error: null };

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
