import type { Metadata } from "next";
import Link from "next/link";
import { ProcurementWorkspace } from "@/components/procurement/procurement-workspace";
import { RealProjectWorkspace } from "@/components/procurement/real-project-workspace";
import { AuthConfigurationError, UnauthenticatedError, isClerkConfigured, requireUserId } from "@/lib/server/auth";
import { UuidSchema } from "@/lib/contracts/primitives";

export const metadata: Metadata = {
  title: "Рабочее место закупок · Tessera",
  description: "Демонстрационное рабочее место менеджера закупок",
};

export default async function WorkspacePage({ searchParams }: { searchParams: Promise<{ projectId?: string | string[] }> }) {
  const { projectId } = await searchParams;
  if (projectId === undefined) return <ProcurementWorkspace />;
  if (typeof projectId !== "string" || !UuidSchema.safeParse(projectId).success) return <main className="mx-auto w-full max-w-3xl px-4 py-12"><h1 className="text-2xl font-semibold">Проект не найден</h1><Link href="/projects" className="mt-4 inline-block text-sm underline underline-offset-4">К списку проектов</Link></main>;
  if (!isClerkConfigured()) return <main className="mx-auto w-full max-w-3xl px-4 py-12"><h1 className="text-2xl font-semibold">Вход недоступен</h1><p className="mt-3 text-sm">Авторизация Clerk пока не настроена.</p></main>;
  let ownerId: string;
  try { ownerId = await requireUserId(); }
  catch (error) {
    if (error instanceof AuthConfigurationError) return <main className="mx-auto w-full max-w-3xl px-4 py-12"><h1 className="text-2xl font-semibold">Вход недоступен</h1></main>;
    if (error instanceof UnauthenticatedError) return <main className="mx-auto w-full max-w-3xl px-4 py-12"><h1 className="text-2xl font-semibold">Войдите для просмотра проекта</h1><Link href="/sign-in" className="mt-4 inline-block text-sm underline underline-offset-4">Войти</Link></main>;
    throw error;
  }
  return <RealProjectWorkspace key={`${ownerId}:${projectId}`} ownerId={ownerId} projectId={projectId} />;
}
