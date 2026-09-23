"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { approveServerReview, downloadApprovedReview, normalizeReviewQuantity, readServerReview, saveServerReview, type ServerReview } from "@/lib/procurement/review-client";

type Draft = { quantity: string; reason: string };
/** Key by runId: drafts and pending responses must never migrate to another run. */
export function PersistedReview({ runId }: { runId: string }) {
  return <ReviewSession key={runId} runId={runId} />;
}
function ReviewSession({ runId }: { runId: string }) {
  const [review, setReview] = useState<ServerReview | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const locked = useRef(false);
  const approvalKey = useRef<{ hash: string; key: string } | null>(null);
  const dirty = Object.keys(drafts).length > 0;
  useEffect(() => {
    const controller = new AbortController();
    readServerReview(runId, controller.signal).then(setReview).catch(() => {
      if (!controller.signal.aborted) setError("Не удалось загрузить проверку. Обновите результат.");
    });
    return () => controller.abort();
  }, [runId]);
  async function action(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Ошибка запроса."); }
    finally { locked.current = false; setBusy(false); }
  }
  function save() {
    if (!review) return;
    void action(async () => {
      const changes = Object.entries(drafts).map(([recommendationId, draft]) => {
        const reason = draft.reason.trim();
        if (!reason || reason.length > 1000) throw new Error("Укажите причину изменения (не более 1000 символов).");
        return { recommendationId, reviewedQty: normalizeReviewQuantity(draft.quantity), reason };
      });
      setReview(await saveServerReview(runId, review.reviewVersion, changes)); setDrafts({});
    });
  }
  function approve() {
    if (!review || dirty || !confirm) return;
    void action(async () => {
      const hash = `${review.reviewVersion}:${review.snapshotHash}`;
      if (approvalKey.current?.hash !== hash) approvalKey.current = { hash, key: crypto.randomUUID() };
      await approveServerReview(runId, review, approvalKey.current.key);
      setReview(await readServerReview(runId)); setConfirm(false);
    });
  }
  const positive = review?.rows.filter((row) => row.quantity !== null && !/^0(?:\.0+)?$/.test(row.quantity)) ?? [];
  const suppliers = new Set(positive.map((row) => row.supplierId).filter(Boolean));
  return <section lang="ru" aria-label="Проверка и утверждение заказа" aria-busy={busy} className="space-y-4 rounded-lg border border-border p-4">
    <h2 className="text-base font-semibold">Проверка заказа</h2>
    <p className="text-sm">Демонстрационный формат, не подтверждён для 1С. Скачивание не означает отправку поставщику.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!review && !error && <p role="status">Загрузка проверки…</p>}
    <Button variant="outline" disabled={busy} onClick={() => { if (!dirty || window.confirm("Отменить несохранённые изменения и загрузить текущую редакцию?")) void action(async () => { setReview(await readServerReview(runId)); setDrafts({}); }); }}>Обновить результат</Button>
    {review && <>
      <p className="text-sm">Редакция {review.reviewVersion}. Всего позиций: {review.rows.length}.</p>
      <fieldset disabled={busy} className="space-y-3">
        <legend className="sr-only">Корректировки количества</legend>
        {review.rows.map((row) => {
          const draft = drafts[row.recommendationId] ?? { quantity: row.quantity ?? "", reason: row.reason ?? "" };
          const update = (next: Draft) => setDrafts((current) => ({ ...current, [row.recommendationId]: next }));
          return <div key={row.recommendationId} className="flex flex-wrap gap-2 border-b border-border pb-3">
            <label className="text-sm">{row.sku} · {row.name} · {row.unit}<input aria-label={`Количество ${row.recommendationId}`} disabled={row.quantity === null || row.quantityStep === null} inputMode="decimal" value={draft.quantity} onChange={(event) => update({ ...draft, quantity: event.target.value })} className="ml-2 rounded-md border border-input px-2 py-1" /></label>
            {row.quantityStep === null && <p className="text-sm">Для изменения нужен новый импорт с политикой единицы SKU.</p>}
            <label className="text-sm">Причина<input maxLength={1000} value={draft.reason} onChange={(event) => update({ ...draft, reason: event.target.value })} className="ml-2 rounded-md border border-input px-2 py-1" /></label>
          </div>;
        })}
      </fieldset>
      {dirty && <p role="status" className="text-sm">Есть несохранённые изменения. Требуется сохранение и повторное утверждение.</p>}
      {review.approval && <p className="text-sm">Утвердил: {review.approval.authorUserId}. Время (UTC): {review.approval.approvedAt}. Редакция: {review.approval.reviewVersion}.</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !dirty} onClick={save}>Сохранить изменения</Button>
        <Button disabled={busy || dirty || !review.canApprove} onClick={() => setConfirm(true)}>Утвердить заказ</Button>
        <Button disabled={busy || dirty || !review.canExport || !review.approval} onClick={() => void action(async () => { if (review.approval) await downloadApprovedReview(runId, review.approval.id); })}>Скачать CSV</Button>
      </div>
      <Dialog open={confirm} onOpenChange={(open) => { if (!busy) setConfirm(open); }}>
        <DialogContent><DialogHeader><DialogTitle>Утвердить заказ?</DialogTitle><DialogDescription>Редакция {review.reviewVersion}. Позиций к заказу: {positive.length}. Поставщиков: {suppliers.size || "см. полный результат"}. Подтверждается весь серверный снимок, не текущая страница.</DialogDescription></DialogHeader>
          <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>Отмена</Button><Button disabled={busy || dirty} onClick={approve}>Подтвердить утверждение</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>}
  </section>;
}
