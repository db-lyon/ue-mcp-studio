/**
 * A render-time throw below this shows a plain message in place of the part
 * that broke, instead of taking the whole app down with it (apps/client-web
 * views/ErrorBoundary.tsx). Reload mounts the part again, which reads its data
 * again. A change of `resetKey`, such as another tab, clears the crash too.
 */
import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { View } from "react-native";
import { Banner, Button, font, T, useTheme } from "../ui";
import { FeedbackDialog } from "./Feedback";
import { noteError } from "../chat/diag";

/** Keep a report inside what the feedback route takes. */
const MAX_STACK = 12_000;

/** The report a crash files: what broke, where, and the stacks. */
export function crashReport(where: string, error: Error, componentStack: string | null): { title: string; description: string } {
  const stack = [error.stack ?? `${error.name}: ${error.message}`, componentStack ? `Component stack:${componentStack}` : ""].filter(Boolean).join("\n\n");
  return {
    title: `${where} could not be shown: ${error.message}`.slice(0, 200),
    description: [
      `${where} crashed while rendering. What I was doing:`,
      "",
      "",
      "Error and stack:",
      "```",
      stack.length > MAX_STACK ? `${stack.slice(0, MAX_STACK)}\n(shortened)` : stack,
      "```",
    ].join("\n"),
  };
}

function Crashed({ what, where, error, componentStack, onReload }: { what: string; where: string; error: Error; componentStack: string | null; onReload: () => void }) {
  const t = useTheme();
  const [reporting, setReporting] = useState(false);
  return (
    <Banner kind="bad" role="alert" style={{ marginVertical: 12 }}>
      <T weight={700} style={{ color: t.c.badText }}>
        {what} could not be shown.
      </T>
      <T style={{ ...font(t, "mono", 400, 12, 1.55), color: t.c.text, marginTop: 6, maxHeight: 9 * 12 * 1.55 }}>{error.message || String(error)}</T>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        <Button title="Reload" onPress={onReload} />
        <Button title="Report this problem" variant="ghost" onPress={() => setReporting(true)} />
      </View>
      {reporting ? <FeedbackDialog initial={crashReport(where, error, componentStack)} onClose={() => setReporting(false)} /> : null}
    </Banner>
  );
}

export class ErrorBoundary extends Component<
  { /** How the message names the part: "This section", "Settings". */ what: string; /** Where it is, for the report: "Settings > Agents". */ where?: string; resetKey?: unknown; children: ReactNode },
  { error: Error | null; componentStack: string | null; key: unknown; mount: number }
> {
  state = { error: null as Error | null, componentStack: null as string | null, key: this.props.resetKey, mount: 0 };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: { resetKey?: unknown }, state: { key: unknown; error: Error | null }) {
    return props.resetKey !== state.key ? { key: props.resetKey, error: null, componentStack: null } : null;
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error(`${this.props.what} could not be shown`, error);
    // Into the diagnostics too, whether or not a screen has hooked the console yet.
    noteError(`${this.props.where ?? this.props.what}: ${error instanceof Error ? error.message : String(error)}`);
  }

  render(): ReactNode {
    const { error, componentStack, mount } = this.state;
    if (error) {
      return <Crashed what={this.props.what} where={this.props.where ?? this.props.what} error={error} componentStack={componentStack} onReload={() => this.setState({ error: null, componentStack: null, mount: mount + 1 })} />;
    }
    return <ErrorBoundaryMount key={mount}>{this.props.children}</ErrorBoundaryMount>;
  }
}

/** A fresh mount per Reload, so the part reads its data again. */
function ErrorBoundaryMount({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
