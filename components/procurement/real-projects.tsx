"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { ApiClientError } from "@/lib/client/procurement-api";
import { RequestScope } from "@/lib/client/request-scope";
import { createProject, listProjectPage } from "@/lib/client/project-data-api";
import type { Project } from "@/lib/contracts/projects";
import { Button } from "@/components/ui/button";

function message(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "Не удалось получить ответ. Повторите попытку.";
}

export function RealProjects({ ownerId }: { ownerId: string }) {
  const { isLoaded, userId } = useAuth();
  if (!isLoaded || userId !== ownerId) return <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
    <h1 className="text-2xl font-semibold">Мои проекты</h1>
    {!isLoaded ? <p role="status" className="mt-3 text-sm text-muted-foreground">Проверяем сессию…</p> : userId ? <div className="mt-3 text-sm"><p>Учётная запись изменилась. Обновите страницу для загрузки своих проектов.</p><Button type="button" variant="outline" className="mt-3" onClick={() => window.location.reload()}>Обновить страницу</Button></div> : <div className="mt-3 text-sm"><p>Сессия завершилась.</p><Link href="/sign-in" className="mt-3 inline-block font-medium underline underline-offset-4">Войти</Link></div>}
  </main>;
  return <ProjectsContent key={ownerId} ownerId={ownerId} />;
}

function ProjectsContent({ ownerId }: { ownerId: string }) {
  const scopeRef = useRef<RequestScope | null>(null);
  const creatingRef = useRef(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [uncertainCreate, setUncertainCreate] = useState(false);

  const loadPage = useCallback((cursor: string | null, verifyCreate = false) => {
    const scope = scopeRef.current;
    if (!scope) return;
    setLoading(true); setError(null);
    void scope.run((signal) => listProjectPage(cursor ?? undefined, signal), {
      onSuccess(page) {
        setProjects((current) => cursor ? [...new Map([...current, ...page.items].map((item) => [item.id, item])).values()] : page.items);
        setNextCursor(page.nextCursor);
        if (verifyCreate) { setUncertainCreate(false); setCreateError(null); }
        setLoading(false);
      },
      onError(cause) {
        if (cause instanceof ApiClientError && cause.kind === "unauthenticated") {
          setProjects([]); setNextCursor(null); setNeedsLogin(true);
        }
        setError(message(cause)); setLoading(false);
      },
    });
  }, []);

  useEffect(() => {
    const scope = new RequestScope();
    scope.setScope(ownerId, null);
    scopeRef.current = scope;
    loadPage(null);
    return () => { scope.logout(); scope.dispose(); scopeRef.current = null; };
  }, [ownerId, loadPage]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scope = scopeRef.current;
    if (!scope || creatingRef.current || loading || uncertainCreate) return;
    creatingRef.current = true;
    setCreating(true); setCreateError(null);
    void scope.run((signal) => createProject(name, signal), {
      onSuccess(project) {
        setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
        setName(""); setCreating(false); creatingRef.current = false;
      },
      onError(cause) {
        if (cause instanceof ApiClientError && cause.kind === "unauthenticated") {
          setProjects([]); setNextCursor(null); setNeedsLogin(true);
        }
        const uncertain = cause instanceof ApiClientError && ["timeout", "network", "invalid_response", "unavailable"].includes(cause.kind);
        setUncertainCreate(uncertain);
        setCreateError(uncertain ? "Ответ не подтверждён. Проект мог быть создан. Обновите список перед повтором." : message(cause));
        setCreating(false); creatingRef.current = false;
      },
    });
  }

  return <div className="flex min-h-dvh min-w-0 bg-background">
    <aside className="hidden w-[200px] shrink-0 border-r border-workspace-nav-border bg-workspace-nav px-4 py-6 md:block" aria-label="Навигация">
      <div className="border-b border-workspace-nav-border pb-6 text-xl font-semibold text-workspace-nav-foreground">tessera</div>
      <nav className="mt-5 space-y-2 text-sm" aria-label="Разделы">
        <span aria-current="page" className="block rounded-md bg-workspace-nav-active px-3 py-3 font-medium text-workspace-nav-active-foreground">Проекты</span>
        <Link href="/" className="block rounded-md px-3 py-3 text-workspace-nav-foreground hover:bg-workspace-nav-active/60 focus-visible:outline-2 focus-visible:outline-ring">Демо закупок</Link>
      </nav>
    </aside>
    <main className="mx-auto w-full max-w-5xl min-w-0 px-4 py-6 sm:px-6 md:py-9">
      <div className="border-b border-border pb-5"><p className="text-sm font-semibold text-workspace-nav-active-foreground md:hidden">tessera</p><h1 className="mt-3 text-2xl font-semibold">Мои проекты</h1><p className="mt-1 text-sm text-muted-foreground">Здесь отображаются только проекты вашей учётной записи.</p></div>
      {needsLogin ? <div className="mt-6" role="alert"><p className="text-sm">Сессия завершилась. Войдите снова.</p><Link href="/sign-in" className="mt-3 inline-block text-sm font-medium underline underline-offset-4">Войти</Link></div> : <>
        <form onSubmit={submit} className="mt-6 max-w-xl border-b border-border pb-6">
          <label htmlFor="project-name" className="block text-sm font-medium">Новый проект</label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row"><input id="project-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required placeholder="Название проекта" className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /><Button type="submit" disabled={creating || loading || uncertainCreate || !name.trim()} className="bg-workspace-nav-active-foreground text-white hover:bg-workspace-nav-foreground">{creating ? "Создаём…" : "Создать"}</Button></div>
          {createError && <div role="alert" className="mt-2 text-sm text-destructive"><p>{createError}</p>{uncertainCreate && <Button type="button" variant="outline" className="mt-2" disabled={loading} onClick={() => loadPage(null, true)}>Обновить список</Button>}</div>}
        </form>
        <section aria-labelledby="project-list-heading" className="mt-6"><h2 id="project-list-heading" className="text-lg font-semibold">Список проектов</h2>
          {loading && projects.length === 0 && <p role="status" className="mt-4 text-sm text-muted-foreground">Загружаем проекты…</p>}
          {error && <div className="mt-4 text-sm" role="alert"><p>{error}</p><Button type="button" variant="outline" className="mt-2" onClick={() => loadPage(projects.length ? nextCursor : null)}>Повторить</Button></div>}
          {!loading && !error && projects.length === 0 && <p className="mt-4 text-sm text-muted-foreground">Проектов пока нет. Создайте первый проект выше.</p>}
          {projects.length > 0 && <ul className="mt-4 divide-y divide-border border-y border-border">{projects.map((project) => <li key={project.id} className="min-w-0 py-4"><Link href={`/?projectId=${project.id}`} className="break-words text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{project.name}</Link><p className="mt-1 text-xs text-muted-foreground">Создан {new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeZone: "Asia/Almaty" }).format(new Date(project.createdAt))}{project.archivedAt ? " · Архив" : ""}</p></li>)}</ul>}
          {nextCursor && !error && <Button type="button" variant="outline" className="mt-4" disabled={loading || creating} onClick={() => loadPage(nextCursor)}>{loading ? "Загружаем…" : "Показать ещё"}</Button>}
        </section>
      </>}
    </main>
  </div>;
}
