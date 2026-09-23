import type { DemoRun, ScenarioId, Stage, StageStatus } from "@/lib/procurement/mock-workspace";

const stages: { id: Stage; label: string }[] = [
  { id: "validate", label: "Проверка данных" },
  { id: "forecast", label: "Прогноз спроса" },
  { id: "recommend", label: "Расчёт заказа" },
  { id: "explain", label: "Подготовка обоснований" },
];
const stageLabels: Record<StageStatus, string> = {
  pending: "Ожидает", running: "Выполняется", succeeded: "Готово", failed: "Ошибка", skipped: "Пропущено",
};

type Props = { scenario: ScenarioId; run: DemoRun | null; stale: boolean; onRetry: () => void };

export function AgentProgress({ scenario, run, stale, onRetry }: Props) {
  if (!run || ["ready", "no-dataset", "importing", "invalid"].includes(scenario)) {
    return <section aria-label="Ход расчёта" className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">Выберите готовые данные и запустите расчёт. Этапов пока нет.</section>;
  }
  const failed = scenario === "failed";
  const cancelled = scenario === "cancelled";
  const running = scenario === "running";
  const disconnected = scenario === "disconnected";
  const degraded = scenario === "degraded";
  const completed = (scenario === "success" || scenario === "no-need") && run.status === "succeeded" &&
    stages.every((stage) => run.stageStates[stage.id] === "succeeded");
  const states: Record<Stage, StageStatus> = running
    ? { validate: "succeeded", forecast: "running", recommend: "pending", explain: "pending" }
    : failed ? { validate: "succeeded", forecast: "failed", recommend: "pending", explain: "pending" }
    : cancelled ? { validate: "succeeded", forecast: "skipped", recommend: "skipped", explain: "skipped" }
    : degraded ? { validate: "succeeded", forecast: "succeeded", recommend: "succeeded", explain: "skipped" }
    : completed ? { validate: "succeeded", forecast: "succeeded", recommend: "succeeded", explain: "succeeded" }
    : run.stageStates;
  const stageList = <ol className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
    {stages.map((stage) => <li key={stage.id} className="rounded-md border border-border px-3 py-2 text-sm"><span className="block font-medium">{stage.label}</span><span className="text-muted-foreground">{stageLabels[states[stage.id]]}</span></li>)}
  </ol>;
  const status = disconnected ? "Связь потеряна" : running ? "Выполняется" : failed ? "Ошибка расчёта" : cancelled ? "Расчёт отменён" : degraded ? "Пояснение недоступно" : completed ? "Готово" : run.status === "queued" ? "В очереди" : run.status === "running" ? "Выполняется" : run.status === "failed" ? "Ошибка расчёта" : run.status === "cancelled" ? "Расчёт отменён" : "Состояние требует проверки";
  return (
    <section aria-labelledby="progress-heading" className="rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="progress-heading" className="text-base font-semibold">Ход расчёта</h2>
          <p className="mt-1 text-sm text-muted-foreground">{run.label} · обновлено {new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" }).format(new Date(run.updatedAt))}</p>
        </div>
        <p role="status" className="text-sm font-medium">{status}</p>
      </div>
      {completed ? <details className="mt-3 border-t border-border pt-3 text-sm"><summary className="w-fit cursor-pointer font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Этапы расчёта</summary>{stageList}</details> : stageList}
      {stale && <p role="status" className="mt-3 text-sm">Параметры изменены — требуется новый расчёт.</p>}
      {disconnected && <p role="alert" className="mt-3 text-sm text-destructive">Связь потеряна — данные могут быть устаревшими. Утверждение и экспорт недоступны.</p>}
      {degraded && <p role="status" className="mt-3 text-sm">ИИ-обоснование недоступно — показан расчёт.</p>}
      {(failed || disconnected) && <button type="button" className="mt-3 text-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring" onClick={onRetry}>Повторить</button>}
    </section>
  );
}
