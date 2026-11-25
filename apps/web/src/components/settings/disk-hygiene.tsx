import type { DiskHygieneCommand, DiskHygieneReport } from "@codeden/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { NumberField } from "@/components/common/number-field";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useClient } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { SettingRow } from "./settings-ui";

const key = ["disk-hygiene"] as const;
const MIB = 1024 ** 2;

function useDiskHygiene() {
  const client = useClient();
  return useQuery({
    queryKey: key,
    queryFn: () => client.diskHygiene.status(),
    refetchInterval: 30_000,
    retry: false,
  });
}

export function DiskHygieneResult({ projectId }: { projectId: string }) {
  const { data } = useDiskHygiene();
  if (!data?.report) return null;
  return [data.report, ...data.history]
    .filter((report) => report.scopes.some((scope) => scope.projectId === projectId))
    .map((report) => <HygieneReport key={report.id} report={report} projectId={projectId} />);
}

function HygieneReport({ report, projectId }: { report: DiskHygieneReport; projectId?: string }) {
  const scopes = report.scopes.filter(
    (scope) => !projectId || scope.projectId === projectId || scope.projectId === null,
  );
  const bytes = scopes
    .filter((scope) => !projectId || scope.projectId === projectId)
    .reduce((sum, scope) => sum + scope.bytesFreed, 0);
  return (
    <details className="my-3 rounded-md border border-border p-3 text-xs">
      <summary className="cursor-pointer font-medium">
        Disk hygiene · {report.dryRun ? "Dry run" : `${formatBytes(bytes)} freed`} ·{" "}
        {new Date(report.at).toLocaleString()}
      </summary>
      {scopes.map((scope) => (
        <div className="mt-3" key={scope.projectId ?? "machine"}>
          <h4 className="font-medium">
            {scope.name} · {formatBytes(scope.bytesFreed)} freed
          </h4>
          {scope.items.length === 0 && <p className="text-muted-foreground">No cleanup items.</p>}
          <ul className="mt-1 space-y-1 text-muted-foreground">
            {scope.items.map((item) => (
              <li key={`${item.path}:${item.disposition}`} className="break-all">
                {item.disposition === "preview" ? "Would clean" : item.disposition}
                {" · "}
                {item.path}
                {" · "}
                {item.reason}
                {item.bytes > 0 && ` · ${formatBytes(item.bytes)}`}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </details>
  );
}

export function DiskHygieneSettings() {
  const { data, isError } = useDiskHygiene();
  const client = useClient();
  const queries = useQueryClient();
  const command = useMutation({
    mutationFn: (input: DiskHygieneCommand) => client.diskHygiene.command(input),
    onSuccess: (status) => queries.setQueryData(key, status),
    onError: (error) => toast.error(error.message),
  });
  if (!data)
    return isError ? (
      <p className="text-xs text-muted-foreground">Disk hygiene is available on this machine.</p>
    ) : null;
  const { config, report, approved, previewId } = data;
  const configure = (patch: Partial<typeof config>) =>
    command.mutate({ action: "configure", config: { ...config, ...patch } });
  const canApprove = previewId && report?.id === previewId && !approved;
  return (
    <>
      <SettingRow
        label="Disk hygiene"
        help="Runs nightly and after updates. Session worktrees use Clean up inactive worktrees above."
      >
        <Switch
          aria-label="Schedule disk hygiene"
          checked={config.enabled}
          disabled={command.isPending}
          onCheckedChange={(enabled) => configure({ enabled })}
        />
      </SettingRow>
      <SettingRow
        label="Dry run only"
        help="Each app version requires a reviewed dry run before cleanup."
      >
        <Switch
          aria-label="Dry run only"
          checked={config.dryRun}
          disabled={command.isPending || !approved}
          onCheckedChange={(dryRun) => configure({ dryRun })}
        />
      </SettingRow>
      <SettingRow
        label="Package cache budget"
        help="Maximum size in MiB for each package cache before maintenance."
      >
        <NumberField
          aria-label="Package cache budget (MiB)"
          min={0}
          max={1048576}
          value={Math.round(config.cacheBudgetBytes / MIB)}
          onChange={(value) => configure({ cacheBudgetBytes: value * MIB })}
          disabled={command.isPending}
          wrapperClassName="w-24"
        />
      </SettingRow>
      <SettingRow
        label="Protected paths"
        help="One path per line. Relative paths start in your home directory. Paths named for kv-migration are always protected."
      >
        <textarea
          aria-label="Protected paths"
          key={config.protectPaths.join("\n")}
          rows={3}
          className="min-w-0 rounded-md border border-input bg-transparent p-2 text-xs"
          defaultValue={config.protectPaths.join("\n")}
          disabled={command.isPending}
          onBlur={(event) => {
            const protectPaths = event.currentTarget.value
              .split("\n")
              .map((path) => path.trim())
              .filter(Boolean);
            if (protectPaths.join("\n") !== config.protectPaths.join("\n"))
              configure({ protectPaths });
          }}
        />
      </SettingRow>
      {report && <HygieneReport report={report} />}
      <div className="flex flex-wrap gap-2 pt-2">
        <Button
          size="sm"
          variant="outline"
          disabled={command.isPending}
          onClick={() => command.mutate({ action: "preview" })}
        >
          Run dry scan
        </Button>
        {canApprove && (
          <Button
            size="sm"
            variant="outline"
            disabled={command.isPending}
            onClick={() => command.mutate({ action: "approve", previewId })}
          >
            Approve cleanup for {data.version}
          </Button>
        )}
        {approved && !config.dryRun && (
          <Button
            size="sm"
            variant="destructive"
            disabled={command.isPending}
            onClick={() => command.mutate({ action: "run" })}
          >
            Run cleanup
          </Button>
        )}
      </div>
    </>
  );
}
