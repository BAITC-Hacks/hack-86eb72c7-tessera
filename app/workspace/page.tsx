import Link from "next/link";
import { PersistedReview } from "@/components/procurement/persisted-review";
import { UuidSchema } from "@/lib/contracts/primitives";
import type { Metadata } from "next";
import { ProcurementWorkspace } from "@/components/procurement/procurement-workspace";

export const metadata: Metadata = {
  title: "Рабочее место закупок · Tessera",
  description: "Демонстрационное рабочее место менеджера закупок",
};

export default async function WorkspacePage({ searchParams }: { searchParams: Promise<{ runId?: string }> }) {
  const { runId } = await searchParams;
  if (runId && UuidSchema.safeParse(runId).success) return <main className="mx-auto w-full max-w-6xl p-6"><PersistedReview runId={runId} /></main>;
  return <><Link className="p-4 underline" href="/workspace/review">Проверить сохранённые расчёты</Link><ProcurementWorkspace /></>;
}
