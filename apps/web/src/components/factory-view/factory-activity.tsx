import { Link } from "@tanstack/react-router";

export function FactoryActivity({
  projectId,
  projectActive,
  activityLoaded = false,
}: {
  projectId: string;
  projectActive: boolean;
  activityLoaded?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b px-4 py-2 text-sm">
      <p>
        {activityLoaded && !projectActive
          ? "No active project work"
          : "No factory-owned work in progress"}
      </p>
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="text-primary hover:underline"
      >
        View project activity
      </Link>
    </div>
  );
}
