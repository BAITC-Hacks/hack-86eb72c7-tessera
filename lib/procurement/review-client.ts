import { z } from "zod";

const ReviewSchema = z.object({
  runId: z.string(), reviewVersion: z.number().int().nonnegative(), snapshotHash: z.string(),
  rows: z.array(z.object({ recommendationId: z.string(), recommendedQty: z.string().nullable(),
    reviewedQty: z.string().nullable(), quantity: z.string().nullable(), reason: z.string().nullable(), unit: z.string(), supplierId: z.string(), sku: z.string(), name: z.string(), quantityPrecision: z.number().nullable(), quantityStep: z.string().nullable() })),
  approval: z.object({ id: z.string(), reviewVersion: z.number(), authorUserId: z.string(), approvedAt: z.string() }).nullable(),
  canApprove: z.boolean(), canExport: z.boolean(),
});
export type ServerReview = z.infer<typeof ReviewSchema>;
export type ReviewChange = { recommendationId: string; reviewedQty: string; reason: string };

export function normalizeReviewQuantity(value: string): string {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d{1,22}(?:\.\d{1,8})?$/.test(normalized)) throw new Error("Введите неотрицательное количество: до 22 цифр и 8 знаков после запятой.");
  const [whole, fraction = ""] = normalized.split(".");
  const tail = fraction.replace(/0+$/, "");
  return whole.replace(/^0+(?=\d)/, "") + (tail ? `.${tail}` : "");
}

async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  if (response.status === 409) throw new Error("Данные изменились. Обновите результат");
  if (response.status === 401) throw new Error("Войдите в аккаунт повторно.");
  if (response.status === 404) throw new Error("Расчёт не найден или доступ запрещён.");
  if (response.status === 422) throw new Error("Проверьте количество, шаг единицы и причину изменения.");
  throw new Error("Не удалось выполнить запрос. Повторите попытку.");
}
const endpoint = (runId: string) => `/api/runs/${encodeURIComponent(runId)}`;
async function reviewResponse(response: Response): Promise<ServerReview> {
  const body: unknown = await (await checked(response)).json();
  return z.object({ data: ReviewSchema }).parse(body).data;
}
export async function readServerReview(runId: string, signal?: AbortSignal): Promise<ServerReview> {
  return reviewResponse(await fetch(`${endpoint(runId)}/review`, { cache: "no-store", signal }));
}
export async function saveServerReview(runId: string, reviewVersion: number, changes: ReviewChange[]): Promise<ServerReview> {
  return reviewResponse(await fetch(`${endpoint(runId)}/recommendations`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewVersion, changes }) }));
}
export async function approveServerReview(runId: string, review: ServerReview, idempotencyKey: string): Promise<void> {
  await checked(await fetch(`${endpoint(runId)}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewVersion: review.reviewVersion, expectedSnapshotHash: review.snapshotHash, confirmed: true, idempotencyKey }) }));
}
export async function downloadApprovedReview(runId: string, approvalId: string): Promise<void> {
  const response = await checked(await fetch(`${endpoint(runId)}/export?approvalId=${encodeURIComponent(approvalId)}&format=csv`, { cache: "no-store" }));
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url; link.download = "заказ-демонстрационный.csv";
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
