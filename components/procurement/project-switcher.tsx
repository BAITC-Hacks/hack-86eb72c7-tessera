"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DemoProject } from "@/lib/procurement/mock-workspace";

type Props = {
  projects: DemoProject[];
  selectedProjectId: string;
  onSelectProject: (id: string) => void;
  onCreate: (name: string) => void;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
};

export function ProjectSwitcher({ projects, selectedProjectId, onSelectProject, onCreate, createOpen, onCreateOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const project = projects.find((item) => item.id === selectedProjectId) ?? projects[0];
  const matches = projects.filter((item) => item.name.toLocaleLowerCase("ru-RU").includes(query.trim().toLocaleLowerCase("ru-RU")));

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { setOpen(false); buttonRef.current?.focus(); }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [open]);

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 120) { setError("Название должно содержать от 1 до 120 символов."); return; }
    onCreate(trimmed);
    setName(""); setError(""); onCreateOpenChange(false);
  }

  return (
    <>
      <div ref={rootRef} className="relative min-w-0">
        <button ref={buttonRef} type="button" aria-label={`Рабочая область: ${project.name}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}
          className="flex max-w-full items-center gap-1 rounded-md py-1 text-left text-sm font-semibold text-foreground hover:text-workspace-nav-active-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <span className="truncate">{project.name}</span><ChevronDown size={16} className="shrink-0" aria-hidden="true" />
        </button>
        {open && <div role="dialog" aria-label="Выбрать рабочую область" className="absolute left-0 top-full z-40 mt-2 w-[min(19rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-2 shadow-lg">
          <label className="sr-only" htmlFor="project-search">Поиск рабочей области</label>
          <input id="project-search" autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти рабочую область"
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <div className="mt-2 max-h-56 overflow-y-auto">
            {matches.length ? matches.map((item) => <button key={item.id} type="button" onClick={() => { setOpen(false); setQuery(""); onSelectProject(item.id); }}
              aria-current={item.id === selectedProjectId ? "true" : undefined}
              className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring aria-[current=true]:bg-workspace-nav-active">
              <span className="truncate">{item.name}</span>{item.id === selectedProjectId && <Check size={16} aria-hidden="true" />}
            </button>) : <p className="px-3 py-3 text-sm text-muted-foreground">Ничего не найдено.</p>}
          </div>
          <button type="button" onClick={() => { setOpen(false); onCreateOpenChange(true); }} className="mt-2 flex min-h-11 w-full items-center gap-2 border-t border-border px-3 pt-2 text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring"><Plus size={16} aria-hidden="true" />Создать рабочую область</button>
        </div>}
      </div>
      <Dialog open={createOpen} onOpenChange={(value) => { onCreateOpenChange(value); if (!value) setError(""); }}>
        <DialogContent showCloseButton={false}>
          <form onSubmit={create} className="space-y-4">
            <DialogHeader><DialogTitle>Новая рабочая область</DialogTitle><DialogDescription>После обновления страницы она исчезнет.</DialogDescription></DialogHeader>
            <label className="block text-sm font-medium" htmlFor="new-project-name">Название</label>
            <input id="new-project-name" autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "new-project-error" : undefined}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            {error && <p id="new-project-error" role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter><Button type="button" variant="outline" onClick={() => onCreateOpenChange(false)}>Отмена</Button><Button type="submit">Создать</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
