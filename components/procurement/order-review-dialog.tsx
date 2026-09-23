"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDecimal, type ApprovedSnapshot } from "@/lib/procurement/review-state";

type Props = {
  mode: "approve" | "preview" | "discard" | null;
  snapshot: ApprovedSnapshot | null;
  candidate: ApprovedSnapshot | null;
  warnings: string[];
  changes: number;
  onClose: () => void;
  onConfirm: () => void;
};

export function OrderReviewDialog({ mode, snapshot, candidate, warnings, changes, onClose, onConfirm }: Props) {
  const shown = mode === "preview" ? snapshot : candidate;
  const suppliers = new Set(shown?.rows.map((row) => row.supplier) ?? []);
  const units = new Set(shown?.rows.map((row) => row.unit) ?? []);
  return (
    <Dialog open={mode !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent showCloseButton={false} className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{mode === "approve" ? "Утвердить заказ" : mode === "preview" ? "Предпросмотр заказа" : "Сбросить ручные правки?"}</DialogTitle>
          <DialogDescription>{mode === "discard" ? "Ручные изменения текущего расчёта будут потеряны." : "Это предпросмотр: заказ не сохраняется и не отправляется поставщику."}</DialogDescription>
        </DialogHeader>
        {mode === "discard" ? (
          <p className="text-sm">Продолжить переключение и сбросить изменения?</p>
        ) : (
          <>
            <div className="text-sm"><p>Поставщиков: {suppliers.size}. Строк к заказу: {shown?.rows.length ?? 0}. Изменений: {changes}.</p><p className="mt-1">Единицы: {[...units].join(", ") || "нет"}. Разные единицы не складываются.</p></div>
            {warnings.length > 0 && <div className="rounded-md border border-border p-3 text-sm"><p className="font-medium">Оговорки</p><ul className="mt-1 list-inside list-disc">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div>}
            {mode === "preview" && (
              <>
                <p className="text-sm font-medium">Предпросмотр — формат 1С не подтверждён.</p>
                <div tabIndex={0} role="region" aria-label="Предпросмотр строк заказа" className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring">
                  <table className="min-w-[620px] w-full text-left text-sm"><thead><tr className="border-b border-border"><th className="py-2 pr-2">Артикул</th><th className="py-2 pr-2">Поставщик</th><th className="py-2 pr-2">К заказу</th><th className="py-2 pr-2">Срочность</th><th className="py-2">Обоснование</th></tr></thead><tbody>{shown?.rows.map((row) => <tr key={`${row.supplier}-${row.sku}`} className="border-b border-border"><td className="py-2 pr-2 font-mono">{row.sku}</td><td className="py-2 pr-2">{row.supplier}</td><td className="py-2 pr-2 tabular-nums">{formatDecimal(row.quantity)} {row.unit}</td><td className="py-2 pr-2">{row.urgency}</td><td className="py-2">{row.explanation}</td></tr>)}</tbody></table>
                </div>
                <p className="text-xs text-muted-foreground">Скачивание пока недоступно.</p>
              </>
            )}
          </>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>{mode === "preview" ? "Закрыть" : "Отмена"}</Button>
          {mode !== "preview" && <Button type="button" onClick={onConfirm}>{mode === "approve" ? "Подтвердить" : "Сбросить и продолжить"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
