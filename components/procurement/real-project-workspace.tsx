"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { ApiClientError } from "@/lib/client/procurement-api";
import { RequestScope } from "@/lib/client/request-scope";
import { getProject, listDatasetPage, type DatasetPage, type DatasetSummary } from "@/lib/client/project-data-api";
import type { Project } from "@/lib/contracts/projects";

type Props = { ownerId: string; projectId: string };

export function RealProjectWorkspace({ ownerId, projectId }: Props) {
  const { isLoaded, userId } = useAuth();
  if (!isLoaded || userId !== ownerId) return <main className="mx-auto w-full max-w-3xl px-4 py-12"><h1 className="text-2xl font-semibold">Проект</h1><p className="mt-3 text-sm">{!isLoaded ? "Проверяем сессию…" : "Сессия изменилась. Обновите страницу."}</p>{isLoaded && <Button type="button" variant="outline" className="mt-3" onClick={() => window.location.reload()}>Обновить</Button>}</main>;
  return <ProjectContent key={`${ownerId}:${projectId}`} ownerId={ownerId} projectId={projectId} />;
}

function ProjectContent({ ownerId, projectId }: Props) {
  const scopeRef = useRef<RequestScope | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<string | null>(null);

  const load = useCallback((cursor: string | null) => {
    const scope = scopeRef.current;
    if (!scope) return;
    setLoading(true); setError(null);
    void scope.run<{ project: Project | null; page: DatasetPage }>((signal) => cursor
      ? listDatasetPage(projectId, cursor, signal).then((page) => ({ project: null, page }))
      : Promise.all([getProject(projectId, signal), listDatasetPage(projectId, undefined, signal)]).then(([found, page]) => ({ project: found, page })), {
      onSuccess(result) {
        if (result.project && result.project.ownerUserId !== ownerId) {
          setProject(null); setDatasets([]); setError("Сервер вернул неожиданный ответ."); setErrorKind("invalid_response"); setLoading(false);
          return;
        }
        if (result.project) setProject(result.project);
        setDatasets((current) => cursor ? [...new Map([...current, ...result.page.items].map((item) => [item.id, item])).values()] : result.page.items);
        setNextCursor(result.page.nextCursor); setLoading(false); setErrorKind(null);
      },
      onError(cause) {
        const kind = cause instanceof ApiClientError ? cause.kind : "unavailable";
        if (kind === "unauthenticated" || kind === "forbidden" || kind === "not_found") {
          setProject(null); setDatasets([]); setNextCursor(null);
        }
        setError(cause instanceof ApiClientError ? cause.message : "Не удалось получить данные проекта.");
        setErrorKind(kind);
        setLoading(false);
      },
    });
  }, [ownerId, projectId]);

  useEffect(() => {
    const scope = new RequestScope();
    scope.setScope(ownerId, projectId);
    scopeRef.current = scope;
    load(null);
    return () => { scope.logout(); scope.dispose(); scopeRef.current = null; };
  }, [ownerId, projectId, load]);

  return <div className="flex min-h-dvh min-w-0 bg-background">
    <aside className="hidden w-[200px] shrink-0 border-r border-workspace-nav-border bg-workspace-nav px-4 py-6 md:block"><div className="border-b border-workspace-nav-border pb-6 text-xl font-semibold text-workspace-nav-foreground">tessera</div><Link href="/projects" className="mt-5 block rounded-md bg-workspace-nav-active px-3 py-3 text-sm font-medium text-workspace-nav-active-foreground focus-visible:outline-2 focus-visible:outline-ring">Проекты</Link></aside>
    <main className="mx-auto w-full max-w-5xl min-w-0 px-4 py-6 sm:px-6 md:py-9">
      <Link href="/projects" className="text-sm font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">← Мои проекты</Link>
      <header className="mt-5 border-b border-border pb-5"><h1 className="break-words text-2xl font-semibold">{project?.name ?? "Проект"}</h1><p className="mt-1 text-sm text-muted-foreground">Версии данных проекта</p></header>
      {loading && !project && <p role="status" className="mt-6 text-sm text-muted-foreground">Загружаем проект…</p>}
      {error && <div role="alert" className="mt-6 text-sm"><p>{errorKind === "not_found" || errorKind === "forbidden" ? "Проект не найден или недоступен." : error}</p>{errorKind === "unauthenticated" && <Link href="/sign-in" className="mt-3 block underline underline-offset-4">Войти</Link>}{errorKind !== "not_found" && errorKind !== "forbidden" && errorKind !== "unauthenticated" && <Button type="button" variant="outline" className="mt-3" onClick={() => load(project ? nextCursor : null)}>Повторить</Button>}</div>}
      {project && <section aria-labelledby="datasets-heading" className="mt-6"><h2 id="datasets-heading" className="text-lg font-semibold">Наборы данных</h2>
        {!loading && !error && datasets.length === 0 && <p className="mt-4 text-sm text-muted-foreground">Версий данных пока нет. Загрузка и расчёты для этого экрана ещё не подключены.</p>}
        {datasets.length > 0 && <ul className="mt-4 divide-y divide-border border-y border-border">{datasets.map((dataset) => <li key={dataset.id} className="py-4 text-sm"><p className="font-medium">Срез на {new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${dataset.asOfDate}T00:00:00Z`))}</p><p className="mt-1 text-muted-foreground">Источников: {dataset.sources.length} · версия схемы {dataset.schemaVersion}</p></li>)}</ul>}
        {nextCursor && !error && <Button type="button" variant="outline" className="mt-4" disabled={loading} onClick={() => load(nextCursor)}>{loading ? "Загружаем…" : "Показать ещё"}</Button>}
        <p className="mt-6 text-sm text-muted-foreground">Расчёт и утверждение заказа для реальных проектов пока не подключены.</p>
      </section>}
    </main>
  </div>;
}
