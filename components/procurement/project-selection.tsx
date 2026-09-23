"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DemoProject } from "@/lib/procurement/mock-workspace";

type Props = {
  projects: DemoProject[];
  selectedProjectId: string;
  selectedRunId: string | null;
  onSelectProject: (id: string) => void;
  onSelectRun: (id: string) => void;
  onCreate: (name: string) => void;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
};

export function ProjectSelection({ projects, selectedProjectId, selectedRunId, onSelectProject, onSelectRun, onCreate, createOpen, onCreateOpenChange }: Props) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const selected = projects.find((project) => project.id === selectedProjectId);

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) {
      setError("Название должно содержать от 1 до 120 символов.");
      return;
    }
    onCreate(trimmed);
    setName("");
    setError("");
    onCreateOpenChange(false);
  }

  return (
    <>
      <nav aria-label="Рабочие области" className="space-y-5">
        <section aria-labelledby="projects-heading">
          <h3 id="projects-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Проекты</h3>
          <div className="space-y-1">
            {projects.map((project) => (
              <button
                key={project.id} type="button" onClick={() => onSelectProject(project.id)}
                aria-current={selectedProjectId === project.id ? "page" : undefined}
                className="w-full rounded-md px-3 py-2 text-left text-sm break-words hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring aria-[current=page]:bg-sidebar-accent"
              >{project.name}</button>
            ))}
          </div>
        </section>
        <section aria-labelledby="runs-heading">
          <h3 id="runs-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">История расчётов</h3>
          {selected?.runs.length ? (
            <div className="space-y-1">
              {selected.runs.map((run) => (
                <button
                  key={run.id} type="button" onClick={() => onSelectRun(run.id)}
                  aria-current={selectedRunId === run.id ? "true" : undefined}
                  className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring aria-[current=true]:bg-sidebar-accent"
                >
                  <span className="block break-words">{run.label}</span>
                  <span className="text-xs text-muted-foreground">{run.status === "succeeded" ? "Готово" : run.status === "failed" ? "Ошибка" : run.status === "running" ? "Выполняется" : "Отменён"}</span>
                </button>
              ))}
            </div>
          ) : <p className="text-sm text-muted-foreground">Расчётов пока нет.</p>}
        </section>
      </nav>
      <Dialog open={createOpen} onOpenChange={(open) => { onCreateOpenChange(open); if (!open) setError(""); }}>
        <DialogContent showCloseButton={false}>
          <form onSubmit={create} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Новая рабочая область</DialogTitle>
              <DialogDescription>Создаётся только в памяти браузера. После обновления страницы исчезнет.</DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <label htmlFor="demo-project-name" className="text-sm font-medium">Название</label>
              <input id="demo-project-name" autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "demo-project-error" : undefined} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              {error && <p id="demo-project-error" role="alert" className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onCreateOpenChange(false)}>Отмена</Button>
              <Button type="submit">Создать в демо</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
