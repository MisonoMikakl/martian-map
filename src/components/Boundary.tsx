import { Component, type ReactNode } from 'react';

interface Props {
  /** 这个值变化时（例如切换场景）清掉错误，重新渲染 */
  resetKey: unknown;
  fallback: (error: Error) => ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
  key: unknown;
}

/** 某一块渲染出错时只替换这一块，不让整页白屏 */
export default class Boundary extends Component<Props, State> {
  state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(p: Props, s: State): Partial<State> | null {
    return p.resetKey !== s.key ? { error: null, key: p.resetKey } : null;
  }

  componentDidCatch(error: Error) {
    console.error('[Martian Map]', error);
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error) : this.props.children;
  }
}
