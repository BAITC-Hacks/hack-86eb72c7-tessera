import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { AuthConfigurationError, UnauthenticatedError, isClerkConfigured, requireUserId } from "@/lib/server/auth";
import { RealProjects } from "@/components/procurement/real-projects";

export const metadata: Metadata = { title: "Проекты · Tessera", description: "Мои проекты закупок" };

export default async function ProjectsPage() {
  await connection();
  if (!isClerkConfigured()) return <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
    <h1 className="text-2xl font-semibold">Вход недоступен</h1>
    <p className="mt-3 text-sm text-muted-foreground">Авторизация Clerk пока не настроена. Список проектов недоступен.</p>
  </main>;
  let ownerId: string;
  try { ownerId = await requireUserId(); }
  catch (error) {
    if (error instanceof AuthConfigurationError) return <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6"><h1 className="text-2xl font-semibold">Вход недоступен</h1><p className="mt-3 text-sm text-muted-foreground">Авторизация временно недоступна.</p></main>;
    if (error instanceof UnauthenticatedError) return <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6"><h1 className="text-2xl font-semibold">Мои проекты</h1><p className="mt-3 text-sm text-muted-foreground">Чтобы увидеть свои проекты, войдите в систему.</p><Link className="mt-5 inline-block rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring" href="/sign-in">Войти</Link></main>;
    throw error;
  }
  return <RealProjects ownerId={ownerId} />;
}
