"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RecommendationDetails } from "./recommendation-details";
import { currentQuantity, formatDecimal, validateQuantity, type DraftEdit, type SavedEdit } from "@/lib/procurement/review-state";
import type { Recommendation } from "@/lib/procurement/mock-workspace";

type Props = {
  rows: Recommendation[];
  selectedSupplierId: string;
  drafts: Record<string, DraftEdit>;
  saved: Record<string, SavedEdit>;
  checkedSuppliers: Set<string>;
  degraded: boolean;
  approved: boolean;
  onDraftChange: (row: Recommendation, draft: DraftEdit) => void;
  onSave: (row: Recommendation) => void;
  onReset: (row: Recommendation) => void;
  onCheck: (supplierId: string, checked: boolean) => void;
};

const inputClass = "h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function RecommendationTable({ rows, selectedSupplierId, drafts, saved, checkedSuppliers, degraded, approved, onDraftChange, onSave, onReset, onCheck }: Props) {
  const [query, setQuery] = useState("");
  const [urgency, setUrgency] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const visibleRows = rows.filter((row) =>
    row.supplierId === selectedSupplierId && (urgency === "all" || row.urgency === urgency) &&
    `${row.sku} ${row.name}`.toLocaleLowerCase("ru-RU").includes(query.trim().toLocaleLowerCase("ru-RU")),
  );
  const supplierIds = [...new Set(visibleRows.map((row) => row.supplierId))];
  const supplierName = (id: string) => visibleRows.find((row) => row.supplierId === id)?.supplier ?? id;

  function toggle(rowId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId); else next.add(rowId);
      return next;
    });
  }

  return (
    <section aria-labelledby="recommendations-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="recommendations-heading" className="text-base font-semibold">Рекомендации по поставщикам</h2>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <label className="w-full min-w-0 text-xs sm:w-56">Поиск по артикулу и названию
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} className={`${inputClass} mt-1 w-full`} />
          </label>
          <label className="w-full text-xs sm:w-auto">Срочность
            <select value={urgency} onChange={(event) => setUrgency(event.target.value)} className={`${inputClass} mt-1 w-full`}>
              <option value="all">Все</option><option value="Срочно">Срочно</option><option value="Планово">Планово</option><option value="Не требуется">Не требуется</option>
            </select>
          </label>
        </div>
      </div>
      {visibleRows.length === 0 ? (
        <div className="rounded-lg border border-border p-5 text-sm">
          <p>По выбранным условиям совпадений нет.</p>
          <Button type="button" variant="outline" className="mt-3" onClick={() => { setQuery(""); setUrgency("all"); }}>Сбросить фильтры</Button>
        </div>
      ) : supplierIds.map((supplierId) => {
        const supplierRows = visibleRows.filter((row) => row.supplierId === supplierId);
        const fullSupplierRows = rows.filter((row) => row.supplierId === supplierId);
        return (
          <div key={supplierId} className="rounded-lg border border-border bg-card p-3 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-base font-semibold">{supplierName(supplierId)} <span className="text-sm font-normal text-muted-foreground">· {supplierRows.length} {supplierRows.length === 1 ? "строка" : supplierRows.length < 5 ? "строки" : "строк"}</span></h3>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={checkedSuppliers.has(supplierId)} disabled={approved} onChange={(event) => onCheck(supplierId, event.target.checked)} className="size-4 accent-foreground" />Проверено<span className="sr-only">: {supplierName(supplierId)}</span></label>
            </div>
            {supplierRows.length !== fullSupplierRows.length && <p className="mt-2 text-xs text-muted-foreground">Показана часть строк поставщика; отметка проверки относится ко всем его строкам.</p>}
            <div tabIndex={0} role="region" aria-label={`Таблица рекомендаций: ${supplierName(supplierId)}`} className="relative mt-3 hidden max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring md:block">
              <table className="w-full min-w-[900px] border-collapse text-left text-sm">
                <caption className="sr-only">Рекомендации поставщика {supplierName(supplierId)}</caption>
                <thead><tr className="border-b border-border text-xs text-muted-foreground"><th scope="col" className="py-2 pr-3">Артикул и товар</th><th scope="col" className="py-2 pr-3">Ед.</th><th scope="col" className="py-2 pr-3 text-right">Рекомендовано</th><th scope="col" className="py-2 pr-3">К заказу</th><th scope="col" className="py-2 pr-3">Срочность</th><th scope="col" className="py-2 pr-3">Обоснование</th><th scope="col" className="py-2">Проверка</th></tr></thead>
                <tbody>
                  {supplierRows.map((row) => {
                    const current = currentQuantity(row, saved);
                    const draft = drafts[row.id] ?? { quantity: current, reason: saved[row.id]?.reason ?? "" };
                    const parsed = validateQuantity(draft.quantity, row.step);
                    const changed = draft.quantity !== current || draft.reason !== (saved[row.id]?.reason ?? "");
                    const reasonRequired = parsed.ok && parsed.value !== row.recommended;
                    const error = !parsed.ok ? parsed.error : reasonRequired && !draft.reason.trim() ? "Укажите причину изменения." : null;
                    return (
                      <tr key={row.id} className="border-b border-border align-top last:border-b-0">
                        <td className="py-3 pr-3"><span className="block font-mono tabular-nums">{row.sku}</span><span className="block max-w-52 break-words">{row.name}</span></td>
                        <td className="py-3 pr-3">{row.unit}</td>
                        <td className="py-3 pr-3 text-right tabular-nums">{formatDecimal(row.recommended)}</td>
                        <td className="min-w-52 py-2 pr-3">
                          <label htmlFor={`quantity-${row.id}`} className="sr-only">Количество к заказу для {row.sku}</label>
                          <input id={`quantity-${row.id}`} inputMode="decimal" value={draft.quantity} disabled={approved} aria-invalid={Boolean(error)} aria-describedby={error ? `error-${row.id}` : undefined} onChange={(event) => onDraftChange(row, { ...draft, quantity: event.target.value })} className={`${inputClass} w-24 tabular-nums`} />
                          <span className="ml-2 text-xs text-muted-foreground">шаг {formatDecimal(row.step)}</span>
                          {(reasonRequired || draft.reason) && <label className="mt-2 block text-xs">Причина правки
                            <input value={draft.reason} disabled={approved} onChange={(event) => onDraftChange(row, { ...draft, reason: event.target.value })} className={`${inputClass} mt-1 w-full`} maxLength={240} />
                          </label>}
                          {error && <p id={`error-${row.id}`} className="mt-1 text-xs text-destructive">{error}</p>}
                          {!approved && <div className="mt-2 flex gap-1"><Button type="button" size="xs" variant="outline" disabled={!changed || Boolean(error)} onClick={() => onSave(row)}>Сохранить</Button><Button type="button" size="xs" variant="ghost" onClick={() => onReset(row)}>Сбросить</Button></div>}
                        </td>
                        <td className="py-3 pr-3">{row.urgency}</td>
                        <td className="max-w-48 py-3 pr-3">{row.summary}<button type="button" aria-expanded={expanded.has(row.id)} aria-controls={`details-${row.id}`} className="mt-1 block font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => toggle(row.id)}>{expanded.has(row.id) ? "Скрыть" : "Подробнее"}</button></td>
                        <td className="py-3">{row.warnings.length ? <span>Есть оговорка</span> : current !== row.recommended ? <span>Изменено</span> : <span>Без правки</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-3 space-y-3 md:hidden">
              {supplierRows.map((row) => {
                const current = currentQuantity(row, saved);
                const draft = drafts[row.id] ?? { quantity: current, reason: saved[row.id]?.reason ?? "" };
                const parsed = validateQuantity(draft.quantity, row.step);
                const changed = draft.quantity !== current || draft.reason !== (saved[row.id]?.reason ?? "");
                const reasonRequired = parsed.ok && parsed.value !== row.recommended;
                const error = !parsed.ok ? parsed.error : reasonRequired && !draft.reason.trim() ? "Укажите причину изменения." : null;
                return <article key={row.id} className="min-w-0 border-t border-border pt-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><p className="font-mono tabular-nums">{row.sku}</p><h4 className="font-medium">{row.name}</h4></div><span className="text-xs text-muted-foreground">{row.urgency}</span></div>
                  <p className="mt-2 text-muted-foreground">Рекомендовано: <span className="tabular-nums text-foreground">{formatDecimal(row.recommended)} {row.unit}</span></p>
                  <label htmlFor={`mobile-quantity-${row.id}`} className="mt-3 block font-medium">К заказу</label>
                  <div className="mt-1 flex items-center gap-2"><input id={`mobile-quantity-${row.id}`} inputMode="decimal" value={draft.quantity} disabled={approved} aria-invalid={Boolean(error)} aria-describedby={error ? `mobile-error-${row.id}` : undefined} onChange={(event) => onDraftChange(row, { ...draft, quantity: event.target.value })} className={`${inputClass} w-28 tabular-nums`} /><span>{row.unit}</span><span className="text-xs text-muted-foreground">шаг {formatDecimal(row.step)}</span></div>
                  {(reasonRequired || draft.reason) && <label className="mt-2 block text-xs">Причина правки<input value={draft.reason} disabled={approved} onChange={(event) => onDraftChange(row, { ...draft, reason: event.target.value })} className={`${inputClass} mt-1 w-full`} maxLength={240} /></label>}
                  {error && <p id={`mobile-error-${row.id}`} className="mt-1 text-xs text-destructive">{error}</p>}
                  {!approved && <div className="mt-2 flex gap-1"><Button type="button" size="xs" variant="outline" disabled={!changed || Boolean(error)} onClick={() => onSave(row)}>Сохранить</Button><Button type="button" size="xs" variant="ghost" onClick={() => onReset(row)}>Сбросить</Button></div>}
                  <button type="button" aria-expanded={expanded.has(row.id)} aria-controls={`mobile-details-${row.id}`} className="mt-3 font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring" onClick={() => toggle(row.id)}>{expanded.has(row.id) ? "Скрыть" : "Почему столько"}</button>
                  {expanded.has(row.id) && <div id={`mobile-details-${row.id}`} className="mt-2"><RecommendationDetails row={row} degraded={degraded} /></div>}
                </article>;
              })}
            </div>
            {supplierRows.filter((row) => expanded.has(row.id)).map((row) => <div key={`details-${row.id}`} id={`details-${row.id}`} className="mt-3 hidden md:block"><RecommendationDetails row={row} degraded={degraded} /></div>)}
          </div>
        );
      })}
    </section>
  );
}
