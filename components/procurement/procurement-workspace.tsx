"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { EditorNavbar } from "@/components/editor/editor-navbar";
import { ProjectSidebar } from "@/components/editor/project-sidebar";
import { Button } from "@/components/ui/button";
import { AgentProgress } from "./agent-progress";
import { CalculationControls } from "./calculation-controls";
import { DataReadinessPanel } from "./data-readiness-panel";
import { OrderReviewDialog } from "./order-review-dialog";
import { ProjectSelection } from "./project-selection";
import { RecommendationTable } from "./recommendation-table";
import {
  dataReady, initialProjects, scenarios, sourcesForScenario,
  type DemoProject, type DemoRun, type Recommendation, type ScenarioId, type Scope,
} from "@/lib/procurement/mock-workspace";
import {
  approvalBlockers, canPreview, clearSupplierCheck, createApprovedSnapshot, currentQuantity, hasManualChanges, scopeChanged,
  validateQuantity, type ApprovedSnapshot, type DraftEdit, type SavedEdit,
} from "@/lib/procurement/review-state";

const SIDEBAR_ID = "workspace-sidebar";
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, DraftEdit>>({});
  const [saved, setSaved] = useState<Record<string, SavedEdit>>({});
  const [checkedSuppliers, setCheckedSuppliers] = useState<Set<string>>(new Set());
  const [approved, setApproved] = useState<ApprovedSnapshot | null>(null);
  const [dialogMode, setDialogMode] = useState<"approve" | "preview" | "discard" | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [autoFinish, setAutoFinish] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
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
  const blockers = approvalBlockers({ scenario, ready, stale, rows, drafts, saved, checkedSuppliers });
  const warnings = [...(dataset?.warnings ?? []), ...rows.flatMap((row) => row.warnings)];
  const candidate = activeRun && blockers.length === 0 ? createApprovedSnapshot(projectId, activeRun.id, rows, saved) : null;
  const changes = rows.filter((row) => currentQuantity(row, saved) !== row.recommended).length;

  const closeSidebar = useCallback(() => { setSidebarOpen(false); toggleRef.current?.focus(); }, []);
  useEffect(() => {
    if (!sidebarOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.target instanceof Element && event.target.closest('[data-slot="dialog-content"]')) return;
      closeSidebar();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [sidebarOpen, closeSidebar]);

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
      closeSidebar();
    });
  }

  function switchRun(id: string) {
    if (id === runId) return;
    const run = project.runs.find((item) => item.id === id);
    if (!run) return;
    changeWithConfirmation(() => {
      setRunId(id); setScope(run.scope); setScenario(scenarioFor(run)); closeSidebar();
    });
  }

  function createProject(name: string) {
    changeWithConfirmation(() => {
      const id = `demo-created-${projects.length + 1}`;
      setProjects((current) => [...current, { id, name, dataset: null, runs: [], recommendations: [] }]);
      setProjectId(id); setRunId(null); setScope(null); setScenario("no-dataset"); closeSidebar();
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
    <div lang="ru" className="flex min-h-screen min-w-0 flex-col bg-background text-foreground">
      <EditorNavbar isSidebarOpen={sidebarOpen} onToggleSidebar={() => sidebarOpen ? closeSidebar() : setSidebarOpen(true)} sidebarId={SIDEBAR_ID} toggleButtonRef={toggleRef} openLabel="Открыть панель рабочих областей" closeLabel="Закрыть панель рабочих областей" />
      <ProjectSidebar id={SIDEBAR_ID} isOpen={sidebarOpen} onClose={closeSidebar} title="Рабочие области" closeLabel="Закрыть панель рабочих областей" footer={<Button type="button" className="w-full" onClick={() => setCreateOpen(true)}><Plus aria-hidden="true" />Создать рабочую область</Button>}>
        <ProjectSelection projects={projects} selectedProjectId={projectId} selectedRunId={runId} onSelectProject={switchProject} onSelectRun={switchRun} onCreate={createProject} createOpen={createOpen} onCreateOpenChange={setCreateOpen} />
      </ProjectSidebar>
      <main className="mx-auto w-full max-w-7xl min-w-0 flex-1 space-y-5 px-4 py-5 sm:px-6 sm:py-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-xs font-medium text-muted-foreground">Демо</p><h1 className="mt-1 text-2xl font-semibold">Рабочее место закупок</h1><p className="mt-1 text-sm text-muted-foreground">{project.name} · {dataset?.name ?? "без набора данных"}</p></div>
          <label className="w-full text-xs font-medium sm:w-64">Сценарий
            <select value={scenario} onChange={(event) => selectScenario(event.target.value as ScenarioId)} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {scenarios.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        </div>
        <DataReadinessPanel key={projectId} dataset={dataset} sources={sources} ready={ready} onShowValidation={() => selectScenario("invalid")} />
        <CalculationControls dataset={dataset} scope={scope} ready={ready} running={scenario === "running"} onScopeChange={(next) => { setScope(next); setApproved(null); setCheckedSuppliers(new Set()); }} onCalculate={startCalculation} />
        <AgentProgress scenario={scenario} run={activeRun} stale={stale} onRetry={startCalculation} />
        {hasResult && activeRun && <p className="text-sm text-muted-foreground">Область показанного результата: склад {dataset?.warehouses.find((warehouse) => warehouse.id === activeRun.scope.warehouseId)?.label ?? activeRun.scope.warehouseId}, {activeRun.scope.category === "all" ? "все категории" : activeRun.scope.category}, дата расчёта {activeRun.scope.asOfDate}, набор {dataset?.version}. Изменение полей выше не меняет этот результат.</p>}
        {hasResult && scenario === "no-need" && <div className="rounded-lg border border-border bg-card p-5 text-sm"><h2 className="font-semibold">Пополнение не требуется</h2><p className="mt-1 text-muted-foreground">Положительных строк заказа нет. Утверждение недоступно.</p></div>}
        {hasResult && rows.length > 0 && <RecommendationTable key={projectId} rows={rows} drafts={drafts} saved={saved} checkedSuppliers={checkedSuppliers} degraded={scenario === "degraded"} approved={Boolean(approved)} onDraftChange={updateDraft} onSave={saveEdit} onReset={resetEdit} onCheck={(id, checked) => setCheckedSuppliers((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; })} />}
        {hasResult && rows.length === 0 && scenario !== "no-need" && <p className="rounded-lg border border-border bg-card p-5 text-sm">Для выбранной области рекомендаций нет. Выберите другой склад или категорию.</p>}
        {hasResult && <section aria-labelledby="review-heading" className="rounded-lg border border-border bg-card p-4 sm:p-5">
          <h2 id="review-heading" className="text-base font-semibold">Проверка заказа</h2>
          {blockers.length > 0 && <div className="mt-2 text-sm" role="status"><p className="font-medium">Пока нельзя утвердить:</p><ul className="mt-1 list-inside list-disc text-muted-foreground">{[...new Set(blockers)].map((reason) => <li key={reason}>{reason}</li>)}</ul></div>}
          {approved && <p role="status" className="mt-2 text-sm">Подтверждено для предпросмотра.</p>}
          <div className="mt-4 flex flex-wrap gap-2">
            {!approved ? <Button type="button" disabled={blockers.length > 0} onClick={() => setDialogMode("approve")}>Утвердить</Button> : <><Button type="button" disabled={!canPreview(approved, stale, scenario)} onClick={() => setDialogMode("preview")}>Предпросмотр заказа</Button><Button type="button" variant="outline" onClick={() => setApproved(null)}>Вернуться к проверке</Button></>}
          </div>
        </section>}
      </main>
      <OrderReviewDialog mode={dialogMode} snapshot={approved} candidate={candidate} warnings={warnings} changes={changes} onClose={() => { setDialogMode(null); setPendingAction(null); }} onConfirm={confirmDialog} />
    </div>
  );
}
