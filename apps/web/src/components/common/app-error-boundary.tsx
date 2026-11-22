import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main role="alert" className="grid min-h-dvh place-content-center gap-4 p-6 text-center">
        <h1 className="text-xl font-semibold">CodeDen could not load</h1>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </main>
    );
  }
}
