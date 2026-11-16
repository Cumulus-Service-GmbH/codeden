import {
  Bug,
  ClipboardCheck,
  Eye,
  GitBranch,
  GitMerge,
  Hammer,
  Hand,
  Headset,
  type LucideIcon,
  RotateCcw,
  ScanSearch,
  Search,
  Telescope,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { providerHue, providerMark } from "@/components/common/provider-logos";
import { cn } from "@/lib/utils";
import { bubbleOf } from "../scene/activity";
import { agentCard, agentLabel } from "../scene/agent-card";
import type { SceneAgent } from "../scene/agents";
import { ACTIVITY_ICON } from "./activity-icons";
import { figureStatus, tagVisible } from "./figure-look";
import type { ScreenFigure } from "./stage";
import { type TagGlyph, tagOf } from "./tags";
import { type ActivityStore, useActivityVersion } from "./use-activity";

/**
 * The DOM layer over Floor mode's canvas (#476): for every agent on the floor a name tag, its
 * thought bubble and an invisible button that keyboard users move between with the arrow keys
 * (the canvas itself is decorative). The stage places them after every frame it draws, through
 * `sync`, without a React render; they re-render only when the agents or their activity change.
 */

export const GLYPH: Record<TagGlyph, LucideIcon> = {
  reproducing: Bug,
  analyzing: Search,
  implementing: Hammer,
  revising: RotateCcw,
  reviewing: ClipboardCheck,
  rebasing: GitBranch,
  merging: GitMerge,
  watching_ci: Eye,
  pm: Headset,
  scout: Telescope,
  area: ScanSearch,
};

export interface OverlayHandle {
  sync: (figures: readonly ScreenFigure[], pxPerUnit: number) => void;
}

/** A provider's mark from its bundled paths, or its monogram. */
export function MarkGlyph({ provider, className }: { provider: string; className?: string }) {
  const mark = providerMark(provider);
  if (!mark) {
    const hue = providerHue(provider);
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex items-center justify-center rounded-full text-[8px] font-bold uppercase",
          className,
        )}
        style={{ background: `oklch(0.72 0.12 ${hue} / 0.2)`, color: `oklch(0.6 0.14 ${hue})` }}
      >
        {provider.charAt(0)}
      </span>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      {mark.map((p) => (
        <path
          key={p.d.slice(0, 24)}
          d={p.d}
          fill={p.fill ?? "currentColor"}
          fillRule={p.evenOdd ? "evenodd" : "nonzero"}
        />
      ))}
    </svg>
  );
}

function Bubble({
  agent,
  store,
  now,
  pinned,
  lifted,
}: {
  agent: SceneAgent;
  store: ActivityStore;
  now: number;
  pinned: boolean;
  lifted: boolean;
}) {
  const waiting = agent.status === "approval";
  const bubble = bubbleOf(store.get(agent.sessionId), now, pinned || waiting);
  if (!bubble && !waiting) return null;
  const Icon = bubble ? ACTIVITY_ICON[bubble.activity.kind] : Hand;
  return (
    <div
      aria-hidden
      className={cn(
        "absolute bottom-0 left-0 flex max-w-48 items-center gap-1 rounded-md border border-border bg-background/95 py-0.5 pr-1.5 pl-2.5 text-2xs leading-tight whitespace-nowrap text-foreground shadow-sm transition-opacity duration-1000 motion-reduce:transition-none",
        bubble?.fading && !waiting ? "opacity-0" : "opacity-100",
      )}
      style={{
        // Neighbours take turns: every other one sits a bubble higher.
        transform: lifted ? "translate(-50%, calc(-100% - 10px))" : "translate(-50%, -6px)",
      }}
      data-testid="factory-view-floor-bubble"
      data-kind={bubble?.activity.kind ?? "waiting"}
    >
      {agent.providerId && (
        <span className="absolute -top-1.5 -left-1.5 flex size-4 items-center justify-center rounded-full border border-border bg-background p-0.5 text-foreground">
          <MarkGlyph provider={agent.providerId} className="size-full" />
        </span>
      )}
      <Icon className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{bubble ? bubble.activity.text : "Waiting for you"}</span>
    </div>
  );
}

function Tag({ agent }: { agent: SceneAgent }) {
  const { text, glyph } = tagOf(agent);
  const Icon = GLYPH[glyph];
  return (
    <div
      aria-hidden
      data-tag
      className="absolute top-0 left-0"
      style={{ transform: "translate(calc(var(--u) * 0.15), calc(var(--u) * 0.24))" }}
    >
      {/* The string it hangs from. */}
      <span className="absolute -top-2.5 left-2 h-3 w-px bg-foreground/40" />
      <span
        className="flex items-center gap-0.5 rounded-[3px] border whitespace-nowrap border-[#d8cfbd] bg-[#fbf7ee] py-px pr-1 pl-1.5 font-mono text-[10px] leading-tight font-semibold text-[#2a2620] shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
        data-testid="factory-view-floor-tag"
      >
        <span className="mr-0.5 size-1 rounded-full bg-[#2a2620]/30" />
        {text}
        <Icon className="size-2.5" strokeWidth={2.5} />
      </span>
    </div>
  );
}

export function FigureLayer({
  ref,
  agents,
  lifted,
  live,
  store,
  now,
  hovered,
  focusKey,
  cardId,
  card,
  onFocusFigure,
  onBlurFigure,
  onActivate,
}: {
  ref: Ref<OverlayHandle>;
  agents: readonly SceneAgent[];
  /** Agents whose bubble sits one higher, so neighbours' don't overlap. */
  lifted: ReadonlySet<string>;
  /** Sessions live enough for a bubble. */
  live: ReadonlySet<string>;
  store: ActivityStore;
  now: number;
  /** The agent whose card is open (and whose bubble stays). */
  hovered: string | null;
  /** The agent whose button is the group's Tab stop. */
  focusKey: string | null;
  cardId: string;
  /** The open card, placed over its figure. */
  card: ReactNode;
  onFocusFigure: (agent: SceneAgent) => void;
  onBlurFigure: () => void;
  onActivate: (agent: SceneAgent) => void;
}) {
  useActivityVersion(store);
  const root = useRef<HTMLDivElement>(null);
  const cardBox = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const last = useRef<{ figures: readonly ScreenFigure[]; u: number } | null>(null);
  const open = useRef(hovered);
  open.current = hovered;

  const apply = () => {
    const el = root.current;
    const frame = last.current;
    if (!el || !frame) return;
    el.style.setProperty("--u", `${frame.u}px`);
    const seen = new Set<string>();
    for (const f of frame.figures) {
      const node = nodes.current.get(f.key);
      if (!node) continue;
      seen.add(f.key);
      node.style.visibility = "";
      node.style.transform = `translate3d(${f.head.x}px, ${f.head.y}px, 0)`;
      node.style.setProperty("--h", `${Math.max(12, f.foot.y - f.head.y)}px`);
      const tag = node.querySelector<HTMLElement>("[data-tag]");
      if (tag) tag.style.visibility = tagVisible(f.status, frame.u) ? "" : "hidden";
    }
    for (const [key, node] of nodes.current) if (!seen.has(key)) node.style.visibility = "hidden";
    const box = cardBox.current;
    const target = frame.figures.find((f) => f.key === open.current);
    if (box && target) {
      // Above the figure when there's room, else below it; kept inside the canvas.
      const width = el.clientWidth;
      const above = target.head.y > 270;
      const x = Math.min(Math.max(target.head.x, 152), Math.max(152, width - 152));
      const y = above ? target.head.y - 10 : target.foot.y + 10;
      box.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, ${above ? "-100%" : "0"})`;
    }
  };

  useImperativeHandle(ref, () => ({
    sync: (figures, u) => {
      last.current = { figures, u };
      apply();
    },
  }));
  // Newly rendered nodes take their places at once.
  useLayoutEffect(apply);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    const edge = e.key === "Home" ? 0 : e.key === "End" ? agents.length - 1 : null;
    if (!step && edge === null) return;
    e.preventDefault();
    const at = agents.findIndex((a) => a.key === focusKey);
    const next = edge ?? (at < 0 ? 0 : (at + step + agents.length) % Math.max(1, agents.length));
    const key = agents[next]?.key;
    if (key) nodes.current.get(key)?.querySelector("button")?.focus();
  };

  return (
    <div
      ref={root}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-testid="factory-view-floor-overlay"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a group of figures with roving focus. */}
      <div role="group" aria-label="Crew on the floor" onKeyDown={onKeyDown}>
        {agents.map((agent) => {
          const label = agentLabel(agentCard(agent, now));
          const isOpen = hovered === agent.key;
          return (
            <div
              key={agent.key}
              ref={(el) => {
                if (el) nodes.current.set(agent.key, el);
                else nodes.current.delete(agent.key);
              }}
              className="absolute top-0 left-0"
              style={{ visibility: "hidden" }}
              data-figure={agent.key}
              data-status={figureStatus(agent)}
            >
              <button
                type="button"
                tabIndex={agent.key === focusKey ? 0 : -1}
                aria-label={label}
                aria-expanded={isOpen}
                aria-controls={isOpen ? cardId : undefined}
                className="absolute top-0 left-0 w-[calc(var(--u)*0.5)] -translate-x-1/2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ height: "var(--h)" }}
                onFocus={() => onFocusFigure(agent)}
                onBlur={onBlurFigure}
                onClick={() => onActivate(agent)}
                data-testid="factory-view-floor-figure"
              />
              <Tag agent={agent} />
              {agent.sessionId && live.has(agent.sessionId) && (
                <Bubble
                  agent={agent}
                  store={store}
                  now={Date.now()}
                  pinned={isOpen}
                  lifted={lifted.has(agent.key)}
                />
              )}
            </div>
          );
        })}
      </div>
      {card && (
        <div ref={cardBox} className="pointer-events-auto absolute top-0 left-0 z-20">
          {card}
        </div>
      )}
    </div>
  );
}
