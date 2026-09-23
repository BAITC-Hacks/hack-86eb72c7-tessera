import type { DemoProject, DemoRun } from "@/lib/procurement/mock-workspace";

const statusLabels: Record<DemoRun["status"], string> = {
  queued: "В очереди",
  running: "Выполняется",
  succeeded: "Готово",
  failed: "Ошибка",
  cancelled: "Отменён",
};

type Props = { project: DemoProject; selectedRunId: string | null; onSelectRun: (id: string) => void };

export function RunHistory({ project, selectedRunId, onSelectRun }: Props) {
  return <section aria-labelledby="history-heading" className="max-w-3xl">
    <h2 id="history-heading" className="text-lg font-semibold">История расчётов</h2>
    {project.runs.length ? <ul className="mt-4 divide-y divide-border border-y border-border">
      {project.runs.map((run) => <li key={run.id}>
        <button type="button" onClick={() => onSelectRun(run.id)} aria-current={selectedRunId === run.id ? "true" : undefined}
          className="flex min-h-16 w-full items-center justify-between gap-4 px-2 py-3 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-[current=true]:bg-workspace-nav-active/50">
          <span><span className="block text-sm font-medium">{run.label}</span><span className="text-xs text-muted-foreground">{new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Almaty" }).format(new Date(run.updatedAt))}</span></span>
          <span className="shrink-0 text-sm">{statusLabels[run.status]}</span>
        </button>
      </li>)}
    </ul> : <p className="mt-4 text-sm text-muted-foreground">Расчётов пока нет.</p>}
  </section>;
}
