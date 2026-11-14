import { createCodePlugin } from "@streamdown/code";
import { memo } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import { cn } from "@/lib/utils";

const code = createCodePlugin({ themes: ["github-light-default", "github-dark-default"] });
const plugins = { code };

/** Renderer options a page of docs needs: its own links and headings, nothing clipped. */
export type MarkdownOptions = Pick<
  StreamdownProps,
  "components" | "controls" | "tableMaxHeight" | "codeBlockMaxHeight" | "lineNumbers"
>;

/** Streaming-safe markdown with Shiki-highlighted code blocks (§13). */
export const Markdown = memo(function Markdown({
  children,
  streaming = false,
  className,
  options,
}: {
  children: string;
  streaming?: boolean;
  className?: string;
  /** Keep it stable (a module constant), or the memo re-renders every time. */
  options?: MarkdownOptions;
}) {
  return (
    <Streamdown
      {...options}
      className={cn("markdown", className)}
      plugins={plugins}
      shikiTheme={["github-light-default", "github-dark-default"]}
      isAnimating={streaming}
      mode={streaming ? "streaming" : "static"}
      linkSafety={{ enabled: false }}
      caret={streaming ? "block" : undefined}
    >
      {children}
    </Streamdown>
  );
});
