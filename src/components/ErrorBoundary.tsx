import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

// Catches render-time crashes so the till shows a recovery screen instead of a
// blank/frozen page.
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-full flex flex-col items-center justify-center p-6 text-center gap-4 bg-stone-50">
          <p className="text-2xl font-bold text-stone-800">Something went wrong</p>
          <p className="text-taupe max-w-xs">
            The app hit an unexpected error. Reload to get back to the till — your
            saved orders are safe.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="h-14 px-8 rounded-xl bg-brand text-white font-semibold text-lg active:bg-brand-dark"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
