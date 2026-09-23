"use client";

import { Button } from "@/components/ui/button";
import type { Dataset, Scope } from "@/lib/procurement/mock-workspace";

type Props = {
  dataset: Dataset | null;
  scope: Scope | null;
  ready: boolean;
  running: boolean;
  onScopeChange: (scope: Scope) => void;
  onCalculate: () => void;
};

const controlClass = "mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function CalculationControls({ dataset, scope, ready, running, onScopeChange, onCalculate }: Props) {
  const disabled = !dataset || !scope || !ready || running;
  return (
    <section aria-labelledby="calculation-heading" className="rounded-lg border border-border bg-card p-4 sm:p-5">
      <h2 id="calculation-heading" className="text-base font-semibold">Параметры расчёта</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-sm font-medium">Склад
          <select className={controlClass} value={scope?.warehouseId ?? ""} disabled={!dataset || !scope} onChange={(event) => scope && onScopeChange({ ...scope, warehouseId: event.target.value })} required>
            {!dataset && <option value="">Нет данных</option>}
            {dataset?.warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.label}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium">Категория
          <select className={controlClass} value={scope?.category ?? "all"} disabled={!dataset || !scope} onChange={(event) => scope && onScopeChange({ ...scope, category: event.target.value })}>
            <option value="all">Все категории</option>
            {dataset?.categories.map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium">Дата расчёта
          <input type="date" className={controlClass} value={scope?.asOfDate ?? ""} disabled={!scope} onChange={(event) => scope && onScopeChange({ ...scope, asOfDate: event.target.value })} required />
        </label>
        <div className="text-sm"><span className="font-medium">Период данных</span><p className="mt-1 text-muted-foreground">{dataset?.period ?? "Нет набора данных"}</p></div>
        <div className="text-sm"><span className="font-medium">Горизонт покрытия</span><p className="mt-1 text-muted-foreground">{dataset?.coverage ?? "Нет данных"}</p></div>
        <div className="text-sm"><span className="font-medium">Прогноз прироста</span><p className="mt-1 text-muted-foreground">{dataset?.growth ?? "Нет данных"}</p></div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <Button type="button" className="bg-workspace-nav-active-foreground text-white hover:bg-workspace-nav-foreground" disabled={disabled} onClick={onCalculate}>Рассчитать потребность</Button>
        {disabled && <p className="text-sm text-muted-foreground">{running ? "Расчёт уже выполняется." : "Для расчёта нужны готовые обязательные данные и выбранный склад."}</p>}
      </div>
    </section>
  );
}
