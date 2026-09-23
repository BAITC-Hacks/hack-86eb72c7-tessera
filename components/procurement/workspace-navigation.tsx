"use client";

import { Database, History, MoreHorizontal, ShoppingCart, SlidersHorizontal } from "lucide-react";

export type WorkspaceView = "purchases" | "data" | "history" | "settings";

const destinations = [
  { id: "purchases", desktop: "Закупки", mobile: "Закупки", icon: ShoppingCart },
  { id: "data", desktop: "Данные", mobile: "Данные", icon: Database },
  { id: "history", desktop: "История", mobile: "История", icon: History },
  { id: "settings", desktop: "Параметры", mobile: "Ещё", icon: SlidersHorizontal, mobileIcon: MoreHorizontal },
] as const;

type Props = { view: WorkspaceView; onChange: (view: WorkspaceView) => void; typing: boolean };

export function WorkspaceNavigation({ view, onChange, typing }: Props) {
  return (
    <>
      <aside className="hidden w-[200px] shrink-0 border-r border-workspace-nav-border bg-workspace-nav px-3 py-6 md:sticky md:top-0 md:flex md:h-dvh md:flex-col" aria-label="Основная навигация">
        <div className="border-b border-workspace-nav-border px-3 pb-6 text-xl font-semibold tracking-tight text-workspace-nav-foreground">tessera</div>
        <nav className="mt-5 space-y-1" aria-label="Разделы">
          {destinations.map(({ id, desktop, icon: Icon }) => (
            <button key={id} type="button" onClick={() => onChange(id)} aria-current={view === id ? "page" : undefined}
              className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium text-workspace-nav-foreground hover:bg-workspace-nav-active/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[current=page]:bg-workspace-nav-active aria-[current=page]:text-workspace-nav-active-foreground">
              <Icon size={18} aria-hidden="true" />{desktop}
            </button>
          ))}
        </nav>
        <div className="mt-auto border-t border-workspace-nav-border px-3 pt-4 text-xs text-workspace-nav-foreground/70">Рабочее место закупок</div>
      </aside>
      {!typing && <nav className="fixed inset-x-0 bottom-0 z-30 flex min-h-[calc(60px+env(safe-area-inset-bottom))] items-start justify-around border-t border-workspace-nav-border bg-workspace-nav px-2 pt-2 pb-[env(safe-area-inset-bottom)] md:hidden" aria-label="Разделы">
        {destinations.map(({ id, mobile, icon: Icon, ...item }) => {
          const MobileIcon = "mobileIcon" in item ? item.mobileIcon : Icon;
          return <button key={id} type="button" onClick={() => onChange(id)} aria-label={mobile} title={mobile} aria-current={view === id ? "page" : undefined}
            className="flex size-12 items-center justify-center rounded-md text-workspace-nav-foreground hover:bg-workspace-nav-active/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[current=page]:bg-workspace-nav-active aria-[current=page]:text-workspace-nav-active-foreground">
            <MobileIcon size={21} aria-hidden="true" />
          </button>;
        })}
      </nav>}
    </>
  );
}
