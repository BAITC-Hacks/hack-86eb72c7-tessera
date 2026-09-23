import type { Metadata } from "next";
import Link from "next/link";
import { ProcurementWorkspace } from "@/components/procurement/procurement-workspace";
import { RealProjectWorkspace } from "@/components/procurement/real-project-workspace";
import { PersistedReview } from "@/components/procurement/persisted-review";
import { UuidSchema } from "@/lib/contracts/primitives";
import { AuthConfigurationError, UnauthenticatedError, isClerkConfigured, requireUserId } from "@/lib/server/auth";

export const metadata: Metadata = {
  title: "Рабочее место закупок · Tessera",
  description: "Рабочее место менеджера закупок",
};

type SearchParams = Promise<{ projectId?: string | string[]; runId?: string | string[] }>;

export default async function WorkspacePage({ searchParams }: { searchParams: SearchParams }) {
  const { projectId, runId } = await searchParams;
  if (projectId === undefined && runId === undefined) return <ProcurementWorkspace />;

  if (projectId !== undefined && runId !== undefined) return <main className="mx-auto w-full max-w-3xl px-4 py-12"><h1 className="text-2xl font-semibold">Выберите один проект или расчёт</h1><Link href="/projects" className="mt-4 inline-block text-sm underline underline-offset-4">К списку проектов</Link></main>;
  const id = projectId ?? runId;
  if (typeof id !== "string" || !UuidSchema.safeParse(id).success) return <main className="mx-auto w-full max-w-3xl px-4 py-12"><h1 className="text-2xl font-semibold">{projectId !== undefined ? "Проект не найден" : "Расчёт не найден"}</h1><Link href="/projects" className="mt-4 inline-block text-sm underline underline-offset-4">К списку проектов</Link></main>;
  if (!isClerkConfigured()) return <main className="mx-auto w-full max-w-3xl px-4 py-12"><h1 className="text-2xl font-semibold">Вход недоступен</h1><p className="mt-3 text-sm">Авторизация Clerk пока не настроена.</p></main>;

  let ownerId: string;
  try { ownerId = await requireUserId(); }
  catch (error) {
    if (error instanceof AuthConfigurationError) return <main className="mx-auto w-full max-w-3xl px-4 py-12"><h1 className="text-2xl font-semibold">Вход недоступен</h1></main>;
    if (error instanceof UnauthenticatedError) return <main className="mx-auto w-full max-w-3xl px-4 py-12"><h1 className="text-2xl font-semibold">Войдите для просмотра {projectId !== undefined ? "проекта" : "расчёта"}</h1><Link href="/sign-in" className="mt-4 inline-block text-sm underline underline-offset-4">Войти</Link></main>;
    throw error;
  }
  if (runId !== undefined) return <main className="mx-auto w-full max-w-6xl p-6"><PersistedReview runId={id} /></main>;
  return <RealProjectWorkspace key={`${ownerId}:${id}`} ownerId={ownerId} projectId={id} />;
}
