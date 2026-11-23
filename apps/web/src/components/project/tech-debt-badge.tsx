import { cn } from "@/lib/utils";

/** A compact open LOW count for navigation and project rows. */
export function TechDebtBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      role="img"
      aria-label={`${count} open tech debt`}
      className={cn(
        "flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-sidebar-accent px-1.5 text-3xs font-semibold text-sidebar-foreground tabular-nums",
        className,
      )}
    >
      {count}
    </span>
  );
}
