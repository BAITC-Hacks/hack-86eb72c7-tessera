"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AgentProgress } from "./agent-progress";
import { CalculationControls } from "./calculation-controls";
import { DataReadinessPanel } from "./data-readiness-panel";
import { OrderReviewDialog } from "./order-review-dialog";
import { ProjectSwitcher } from "./project-switcher";
import { RecommendationTable } from "./recommendation-table";
import { RunHistory } from "./run-history";
import { WorkspaceNavigation, type WorkspaceView } from "./workspace-navigation";
import {
  dataReady, initialProjects, scenarios, sourcesForScenario,
  type DemoProject, type DemoRun, type Recommendation, type ScenarioId, type Scope,
} from "@/lib/procurement/mock-workspace";
import {
  approvalBlockers, canPreview, clearSupplierCheck, createApprovedSnapshot, currentQuantity, hasManualChanges, scopeChanged,
  validateQuantity, type ApprovedSnapshot, type DraftEdit, type SavedEdit,
} from "@/lib/procurement/review-state";

const finishedStages: DemoRun["stageStates"] = { validate: "succeeded", forecast: "succeeded", recommend: "succeeded", explain: "succeeded" };

function scopeFor(project: DemoProject): Scope | null {
  const dataset = project.dataset;
  if (!dataset) return null;
  return { warehouseId: dataset.warehouses[0]?.id ?? "", category: "all", asOfDate: dataset.asOfDate };
}

function scenarioFor(run: DemoRun | undefined): ScenarioId {
  if (!run) return "ready";
  if (run.status === "failed") return "failed";
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "running" || run.status === "queued") return "running";
  return "success";
}

export function ProcurementWorkspace() {
  const [projects, setProjects] = useState<DemoProject[]>(initialProjects);
  const [projectId, setProjectId] = useState(initialProjects[0].id);
  const [runId, setRunId] = useState<string | null>(initialProjects[0].runs[0].id);
  const [scenario, setScenario] = useState<ScenarioId>("success");
  const [scope, setScope] = useState<Scope | null>(scopeFor(initialProjects[0]));
  const [view, setView] = useState<WorkspaceView>("purchases");
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, DraftEdit>>({});
  const [saved, setSaved] = useState<Record<string, SavedEdit>>({});
  const [checkedSuppliers, setCheckedSuppliers] = useState<Set<string>>(new Set());
  const [approved, setApproved] = useState<ApprovedSnapshot | null>(null);
  const [dialogMode, setDialogMode] = useState<"approve" | "preview" | "discard" | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [autoFinish, setAutoFinish] = useState(false);
  const nextRun = useRef(1);

  const project = projects.find((item) => item.id === projectId) ?? projects[0];
  const dataset = scenario === "no-dataset" ? null : project.dataset;
  const selectedRun = project.runs.find((run) => run.id === runId) ?? null;
  const activeRun = selectedRun ?? (dataset && scope && !["ready", "no-dataset", "importing", "invalid"].includes(scenario) ? {
    id: "scenario-run", label: "Новый расчёт", datasetId: dataset.id, scope,
    status: "succeeded" as const, stage: "explain" as const, stageStates: finishedStages,
    explanation: "succeeded" as const, updatedAt: "2026-09-20T10:30:00+05:00",
  } : null);
  const sources = sourcesForScenario(dataset, scenario);
  const ready = dataReady(dataset, scenario);
  const stale = Boolean(scope && selectedRun && (scopeChanged(scope, selectedRun.scope) || selectedRun.datasetId !== dataset?.id));
  const hasResult = Boolean(dataset && activeRun && ["success", "degraded", "disconnected", "no-need"].includes(scenario));
  const rows = hasResult && scenario !== "no-need"
    ? project.recommendations.filter((row) => row.warehouseId === activeRun?.scope.warehouseId && (activeRun?.scope.category === "all" || row.category === activeRun?.scope.category))
    : [];
  const suppliers = [...new Map(rows.map((row) => [row.supplierId, row.supplier])).entries()];
  const currentSupplierId = suppliers.some(([id]) => id === selectedSupplierId) ? selectedSupplierId! : suppliers[0]?.[0] ?? "";
  const blockers = approvalBlockers({ scenario, ready, stale, rows, drafts, saved, checkedSuppliers });
  const warnings = [...(dataset?.warnings ?? []), ...rows.flatMap((row) => row.warnings)];
  const candidate = activeRun && blockers.length === 0 ? createApprovedSnapshot(projectId, activeRun.id, rows, saved) : null;
  const changes = rows.filter((row) => currentQuantity(row, saved) !== row.recommended).length;

  useEffect(() => {
    let blurTimer: number | undefined;
    const update = () => {
      const active = document.activeElement;
      setTyping(active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLInputElement && ["text", "search", "email", "url", "tel", "password", "number"].includes(active.type)) ||
        (active instanceof HTMLElement && active.isContentEditable));
    };
    const onFocus = () => { window.clearTimeout(blurTimer); blurTimer = undefined; update(); };
    const onBlur = () => { window.clearTimeout(blurTimer); blurTimer = window.setTimeout(() => { blurTimer = undefined; update(); }, 0); };
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    return () => { document.removeEventListener("focusin", onFocus); document.removeEventListener("focusout", onBlur); window.clearTimeout(blurTimer); };
  }, []);

  useEffect(() => {
    if (!autoFinish || scenario !== "running" || !runId) return;
    const timer = window.setTimeout(() => {
      setProjects((current) => current.map((item) => item.id === projectId ? {
        ...item, runs: item.runs.map((run) => run.id === runId ? {
          ...run, status: "succeeded" as const, stage: "explain" as const,
          stageStates: finishedStages, explanation: "succeeded" as const,
          updatedAt: new Date().toISOString(),
        } : run),
      } : item));
      setScenario("success");
      setAutoFinish(false);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [autoFinish, scenario, runId, projectId]);

  function resetReview() {
    setDrafts({}); setSaved({}); setCheckedSuppliers(new Set()); setApproved(null); setAutoFinish(false);
  }

  function changeWithConfirmation(action: () => void) {
    if (hasManualChanges(project.recommendations, drafts, saved) || approved) {
      setPendingAction(() => action);
      setDialogMode("discard");
      return;
    }
    resetReview();
    action();
  }

  function switchProject(id: string) {
    if (id === projectId) return;
    const next = projects.find((item) => item.id === id);
    if (!next) return;
    changeWithConfirmation(() => {
      setProjectId(id);
      setRunId(next.runs[0]?.id ?? null);
      setScope(next.runs[0]?.scope ?? scopeFor(next));
      setScenario(next.dataset ? scenarioFor(next.runs[0]) : "no-dataset");
      setView(next.dataset ? "purchases" : "data");
    });
  }

  function switchRun(id: string) {
    if (id === runId) return;
    const run = project.runs.find((item) => item.id === id);
    if (!run) return;
    changeWithConfirmation(() => {
      setRunId(id); setScope(run.scope); setScenario(scenarioFor(run)); setView("purchases");
    });
  }

  function createProject(name: string) {
    changeWithConfirmation(() => {
      const id = `demo-created-${projects.length + 1}`;
      setProjects((current) => [...current, { id, name, dataset: null, runs: [], recommendations: [] }]);
      setProjectId(id); setRunId(null); setScope(null); setScenario("no-dataset"); setView("data");
    });
  }

  function selectScenario(id: ScenarioId) {
    if (id === scenario) return;
    changeWithConfirmation(() => { setScenario(id); setAutoFinish(false); });
  }

  function startCalculation() {
    if (!ready || !scope || scenario === "running" || !dataset) return;
    changeWithConfirmation(() => {
      const id = `demo-local-run-${nextRun.current++}`;
      const run: DemoRun = {
        id, label: `Локальный расчёт · ${scope.asOfDate}`, datasetId: dataset.id, scope: { ...scope },
        status: "running", stage: "forecast",
        stageStates: { validate: "succeeded", forecast: "running", recommend: "pending", explain: "pending" },
        explanation: "pending", updatedAt: new Date().toISOString(),
      };
      setProjects((current) => current.map((item) => item.id === projectId ? { ...item, runs: [run, ...item.runs] } : item));
      setRunId(id); setScenario("running"); setAutoFinish(true);
    });
  }

  function updateDraft(row: Recommendation, draft: DraftEdit) {
    setDrafts((current) => ({ ...current, [row.id]: draft }));
    setCheckedSuppliers((current) => clearSupplierCheck(current, row.supplierId));
  }

  function saveEdit(row: Recommendation) {
    const draft = drafts[row.id];
    if (!draft) return;
    const parsed = validateQuantity(draft.quantity, row.step);
    if (!parsed.ok || (parsed.value !== row.recommended && !draft.reason.trim())) return;
    const edit = { quantity: parsed.value, reason: parsed.value === row.recommended ? "" : draft.reason.trim() };
    setSaved((current) => ({ ...current, [row.id]: edit }));
    setDrafts((current) => ({ ...current, [row.id]: edit }));
    setCheckedSuppliers((current) => clearSupplierCheck(current, row.supplierId));
  }

  function resetEdit(row: Recommendation) {
    setDrafts((current) => { const next = { ...current }; delete next[row.id]; return next; });
    setSaved((current) => { const next = { ...current }; delete next[row.id]; return next; });
    setCheckedSuppliers((current) => clearSupplierCheck(current, row.supplierId));
  }

  function confirmDialog() {
    if (dialogMode === "discard") {
      resetReview(); pendingAction?.(); setPendingAction(null);
    } else if (dialogMode === "approve" && candidate && !approved) {
      setApproved(candidate);
    }
    setDialogMode(null);
  }

  return (
    <div lang="ru" className="flex min-h-dvh min-w-0 bg-background text-foreground">
      <WorkspaceNavigation view={view} onChange={setView} typing={typing} />
      <main className="mx-auto w-full max-w-[1440px] min-w-0 flex-1 space-y-6 px-4 py-5 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-6 md:py-7 md:pb-8">
        <header className="min-w-0 border-b border-border pb-5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <ProjectSwitcher projects={projects} selectedProjectId={projectId} onSelectProject={switchProject} onCreate={createProject} createOpen={createOpen} onCreateOpenChange={setCreateOpen} />
            <span className="text-xs font-medium text-muted-foreground">Демо</span>
          </div>
          <h1 className="mt-3 text-2xl font-semibold">{view === "purchases" ? "Закупки" : view === "data" ? "Данные" : view === "history" ? "История" : "Параметры"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{dataset?.name ?? "Набор данных не выбран"}</p>
        </header>

        {view === "data" && <DataReadinessPanel key={projectId} dataset={dataset} sources={sources} ready={ready} onShowValidation={() => selectScenario("invalid")} />}

        {view === "history" && <RunHistory project={project} selectedRunId={runId} onSelectRun={switchRun} />}

        {view === "settings" && <div className="space-y-5">
          <CalculationControls dataset={dataset} scope={scope} ready={ready} running={scenario === "running"} onScopeChange={(next) => { setScope(next); setApproved(null); setCheckedSuppliers(new Set()); }} onCalculate={() => { startCalculation(); setView("purchases"); }} />
          <label className="block max-w-xs text-sm font-medium">Сценарий просмотра
            <select value={scenario} onChange={(event) => selectScenario(event.target.value as ScenarioId)} className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {scenarios.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        </div>}

        {view === "purchases" && <div className="min-w-0 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 text-sm text-muted-foreground">
              <p>{ready ? "Данные готовы к расчёту" : "Для расчёта нужны готовые данные"}</p>
              <button type="button" className="mt-1 font-medium text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setView(ready ? "settings" : "data")}>{ready ? "Настроить параметры" : "Проверить данные"}</button>
            </div>
            <Button type="button" className="bg-workspace-nav-active-foreground text-white hover:bg-workspace-nav-foreground" disabled={!ready || !scope || scenario === "running"} onClick={startCalculation}>Рассчитать потребность</Button>
          </div>
          <AgentProgress scenario={scenario} run={activeRun} stale={stale} onRetry={startCalculation} />
          {hasResult && activeRun && <p className="text-sm text-muted-foreground">Результат: склад {dataset?.warehouses.find((warehouse) => warehouse.id === activeRun.scope.warehouseId)?.label ?? activeRun.scope.warehouseId}, {activeRun.scope.category === "all" ? "все категории" : activeRun.scope.category}, {activeRun.scope.asOfDate}, набор {dataset?.version}. {stale ? "Параметры изменены — нужен новый расчёт." : ""}</p>}
          {hasResult && scenario === "no-need" && <div className="rounded-lg border border-border bg-card p-5 text-sm"><h2 className="font-semibold">Пополнение не требуется</h2><p className="mt-1 text-muted-foreground">Положительных строк заказа нет. Утверждение недоступно.</p></div>}
          {hasResult && rows.length > 0 && <div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-start">
            <aside className="hidden w-[232px] shrink-0 border-r border-border pr-3 xl:block" aria-label="Поставщики">
              <h2 className="mb-3 text-sm font-semibold">Поставщики</h2>
              <nav className="space-y-1" aria-label="Выбор поставщика">
                {suppliers.map(([id, name]) => <button key={id} type="button" onClick={() => setSelectedSupplierId(id)} aria-current={currentSupplierId === id ? "true" : undefined}
                  className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-[current=true]:bg-workspace-nav-active">
                  <span className="min-w-0 truncate">{name}</span><span className="text-xs text-muted-foreground">{rows.filter((row) => row.supplierId === id).length}</span>
                </button>)}
              </nav>
            </aside>
            <label className="block text-sm font-medium xl:hidden">Поставщик
              <select value={currentSupplierId} onChange={(event) => setSelectedSupplierId(event.target.value)} className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {suppliers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            <div className="min-w-0 flex-1"><RecommendationTable key={projectId} rows={rows} selectedSupplierId={currentSupplierId} drafts={drafts} saved={saved} checkedSuppliers={checkedSuppliers} degraded={scenario === "degraded"} approved={Boolean(approved)} onDraftChange={updateDraft} onSave={saveEdit} onReset={resetEdit} onCheck={(id, checked) => setCheckedSuppliers((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; })} /></div>
          </div>}
          {hasResult && rows.length === 0 && scenario !== "no-need" && <p className="rounded-lg border border-border bg-card p-5 text-sm">Для выбранной области рекомендаций нет. Выберите другой склад или категорию.</p>}
          {hasResult && <section aria-labelledby="review-heading" className="rounded-lg border border-border bg-card p-4 sm:p-5">
            <h2 id="review-heading" className="text-base font-semibold">Проверка заказа</h2>
            {blockers.length > 0 && <div className="mt-2 text-sm" role="status"><p className="font-medium">Пока нельзя утвердить:</p><ul className="mt-1 list-inside list-disc text-muted-foreground">{[...new Set(blockers)].map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
            {approved && <p role="status" className="mt-2 text-sm">Подтверждено для предпросмотра.</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              {!approved ? <Button type="button" className="bg-workspace-nav-active-foreground text-white hover:bg-workspace-nav-foreground" disabled={blockers.length > 0} onClick={() => setDialogMode("approve")}>Утвердить</Button> : <><Button type="button" className="bg-workspace-nav-active-foreground text-white hover:bg-workspace-nav-foreground" disabled={!canPreview(approved, stale, scenario)} onClick={() => setDialogMode("preview")}>Предпросмотр заказа</Button><Button type="button" variant="outline" onClick={() => setApproved(null)}>Вернуться к проверке</Button></>}
            </div>
          </section>}
        </div>}
      </main>
      <OrderReviewDialog mode={dialogMode} snapshot={approved} candidate={candidate} warnings={warnings} changes={changes} onClose={() => { setDialogMode(null); setPendingAction(null); }} onConfirm={confirmDialog} />
    </div>
  );
}
