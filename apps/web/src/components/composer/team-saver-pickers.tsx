import { TeamRole, type TokenSaverLevel } from "@codeden/contracts";
import { Check, Gauge, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { TRIGGER_CLASS } from "./model-picker/trigger";

/** How each Team role reads in the composer (the title tag it adds). */
export const TEAM_ROLE_LABEL: Record<TeamRole, string> = {
  architect: "Architect",
  writer: "Writer",
  uiWriter: "UI Writer",
  agentsMdWriter: "AGENTS.md Writer",
  planReviewer: "Plan Reviewer",
  reviewer: "Code Reviewer",
  arbiter: "Arbiter",
  reviewerFallback: "Code Reviewer Fallback",
  investigator: "Investigator",
  browserTester: "Browser Tester",
  operator: "Operator",
  browserOperator: "Browser Operator",
};

const SAVER_LEVELS: { level: TokenSaverLevel; label: string; description: string }[] = [
  { level: "off", label: "Off", description: "No token saver note." },
  { level: "lite", label: "Lite", description: "Short answers, no filler." },
  { level: "full", label: "Full", description: "Terse: fragments allowed." },
  { level: "ultra", label: "Ultra", description: "Telegraphic, the fewest tokens." },
];

/**
 * The new session's Team role: its title gets the role's tag, and a provider, model or effort you
 * don't pick comes from the Team (the project's, then the default Team). None: no role.
 */
export function TeamRolePicker({
  value,
  onChange,
}: {
  value: TeamRole | null;
  onChange: (role: TeamRole | null) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(TRIGGER_CLASS, value && "text-primary")}
          aria-label="Team role"
        >
          <Users className="size-3.5" />
          {value ? TEAM_ROLE_LABEL[value] : "Team"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="text-2xs">
          Team role: its provider, model and effort come from the Team unless you pick them
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <Check className={cn("size-4", value !== null && "invisible")} />
          No role
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {TeamRole.options.map((role) => (
          <DropdownMenuItem key={role} onSelect={() => onChange(role)}>
            <Check className={cn("size-4", value !== role && "invisible")} />
            {TEAM_ROLE_LABEL[role]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The new session's token saver level; Default uses the project's, the role's, then the global level. */
export function SaverPicker({
  value,
  onChange,
}: {
  value: TokenSaverLevel | null;
  onChange: (level: TokenSaverLevel | null) => void;
}) {
  const current = SAVER_LEVELS.find((s) => s.level === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(TRIGGER_CLASS, value && "text-primary")}
          aria-label="Token saver"
        >
          <Gauge className="size-3.5" />
          {current ? `Saver: ${current.label}` : "Saver"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-2xs">Token saver for this session</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onChange(null)} className="items-start py-1.5">
          <Check className={cn("mt-0.5 size-4", value !== null && "invisible")} />
          <span>
            <span className="block text-[13px]">Default</span>
            <span className="block text-2xs text-muted-foreground">
              The project's, the role's, then the global level.
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {SAVER_LEVELS.map((s) => (
          <DropdownMenuItem
            key={s.level}
            onSelect={() => onChange(s.level)}
            className="items-start py-1.5"
          >
            <Check className={cn("mt-0.5 size-4", value !== s.level && "invisible")} />
            <span>
              <span className="block text-[13px]">{s.label}</span>
              <span className="block text-2xs text-muted-foreground">{s.description}</span>
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
