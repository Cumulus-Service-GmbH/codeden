import type { FactoryStatus } from "@codeden/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Maximize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRoleSession } from "@/components/orchestration/role-chat";
import { Button } from "@/components/ui/button";
import { usePrefersReducedMotion } from "@/lib/motion";
import type { PixelChat } from "../pixel/pixel-scene";
import { PmTerminal } from "../pixel/pm-terminal";
import type { SceneAgent } from "../scene/agents";
import { bayCount } from "../scene/repair-bay";
import { sceneSummary } from "../scene/scene-model";
import type { SessionInfo, ViewCard, ViewPipeline } from "../stages";
import { useFloorPalette } from "./palette";
import { ROSTER_SPACE, Roster } from "./roster";
import { FloorStage } from "./stage";
import { useWorkshop } from "./use-workshop";

const TERMINAL_W = 340;

/**
 * Floor mode (#420): the factory as a 3D Workshop, every agent a small crew figure at the
 * station for its step, seated from the agent limit and never left over as "+N". Plain Three.js
 * behind a pure model, in its own chunk. The canvas is decorative: the roster lists every agent
 * as a button and a live caption says what the scene shows. Drag to pan, wheel or pinch to zoom,
 * Fit (or a double-click) to frame it all again. Without WebGL it tells the view to show the
 * board instead.
 */
export function FloorScene({
  f,
  pipeline,
  sessions,
  projectId,
  now,
  onOpen,
  chat,
  onUnsupported,
}: {
  f: FactoryStatus;
  pipeline: ViewPipeline;
  sessions: ReadonlyMap<string, SessionInfo>;
  projectId: string;
  now: number;
  onOpen: (card: ViewCard) => void;
  chat: PixelChat;
  /** WebGL couldn't start, or its context was lost and not restored. */
  onUnsupported: () => void;
}) {
  const pm = useRoleSession("pm", projectId);
  const { scene, layout } = useWorkshop({ f, pipeline, sessions, pmSessionId: pm?.id ?? null });
  const palette = useFloorPalette();
  const reduced = usePrefersReducedMotion();
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<FloorStage | null>(null);
  const terminal = useRef<HTMLElement>(null);
  const navigate = useNavigate();
  // The roster starts open where there's room beside the floor.
  const [rosterOpen, setRosterOpen] = useState(() => window.innerWidth >= 1600);
  const unsupported = useRef(onUnsupported);
  unsupported.current = onUnsupported;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    try {
      stage.current = new FloorStage(el, () => unsupported.current());
    } catch {
      unsupported.current();
      return;
    }
    return () => {
      stage.current?.dispose();
      stage.current = null;
    };
  }, []);

  useEffect(() => {
    if (stage.current) stage.current.reduced = reduced;
  }, [reduced]);

  useEffect(() => {
    stage.current?.setInset(rosterOpen ? ROSTER_SPACE : 0);
  }, [rosterOpen]);

  useEffect(() => {
    stage.current?.update({ layout, scene, palette });
  }, [layout, scene, palette]);

  const focusChat = () => {
    chat.setOpen(true);
    // After the terminal renders: its message box.
    window.setTimeout(() => terminal.current?.querySelector("textarea")?.focus(), 60);
  };
  const openItem = (a: SceneAgent): (() => void) | null => {
    const card = a.card;
    if (card) return () => onOpen(card);
    return a.role === "pm" ? focusChat : null;
  };
  const activate = (a: SceneAgent) => {
    const open = openItem(a);
    if (open) return open();
    if (a.sessionId)
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: a.sessionId } });
  };
  const terminalProps = { projectId, onFold: () => chat.setOpen(false), ref: terminal };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="factory-view-floor-scene">
      <div className="flex min-h-0 flex-1 gap-2">
        <div
          ref={host}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-muted/20"
        >
          {/* The stage puts its canvas (aria-hidden) here. */}
          <Roster
            agents={scene.agents}
            now={now}
            open={rosterOpen}
            setOpen={setRosterOpen}
            onActivate={activate}
            onOpenItem={openItem}
          />
          <Button
            size="sm"
            variant="outline"
            className="absolute right-2 bottom-2 z-10 bg-background/90"
            onClick={() => stage.current?.fit(true)}
            title="Frame the whole factory floor (or double-click the floor)"
            data-testid="factory-view-floor-fit"
          >
            <Maximize2 /> Fit
          </Button>
          {!chat.docked && chat.open && (
            <PmTerminal
              {...terminalProps}
              className="absolute inset-y-0 right-0 z-30 w-[min(360px,85%)]"
            />
          )}
        </div>
        {chat.docked &&
          (chat.open ? (
            <PmTerminal {...terminalProps} className="shrink-0" style={{ width: TERMINAL_W }} />
          ) : (
            <button
              type="button"
              onClick={focusChat}
              className="flex w-8 shrink-0 flex-col items-center gap-2 rounded-lg border border-border bg-surface/40 py-2 text-2xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              aria-label="Show the PM chat"
              data-testid="factory-view-chat-show"
            >
              <span className="[writing-mode:vertical-rl]">PM chat</span>
            </button>
          ))}
      </div>
      <p
        aria-live="polite"
        className="shrink-0 text-center text-2xs text-muted-foreground"
        data-testid="factory-view-floor-summary"
        data-bay={bayCount(scene.bay)}
      >
        {sceneSummary(scene)}
      </p>
    </div>
  );
}
