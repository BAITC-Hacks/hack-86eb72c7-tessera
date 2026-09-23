"use client"

import type { ReactNode } from "react"
import { Plus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

type ProjectSidebarProps = {
  isOpen: boolean
  onClose: () => void
  id?: string
  title?: string
  closeLabel?: string
  children?: ReactNode
  footer?: ReactNode
}

function ProjectSidebar({
  isOpen,
  onClose,
  id,
  title = "Проекты",
  closeLabel = "Закрыть панель проектов",
  children,
  footer,
}: ProjectSidebarProps) {
  return (
    <aside
      id={id}
      aria-label={title}
      aria-hidden={!isOpen}
      inert={!isOpen}
      className={cn(
        "fixed top-16 bottom-2 left-2 z-40 flex w-80 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-lg transition-transform duration-200 ease-out motion-reduce:transition-none",
        isOpen ? "translate-x-0" : "pointer-events-none -translate-x-[calc(100%+1rem)]"
      )}
    >
      <header className="flex items-center justify-between border-b border-sidebar-border p-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={closeLabel}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>

      {children !== undefined ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      ) : (
        <Tabs defaultValue="my-projects" className="min-h-0 flex-1 overflow-y-auto p-4">
          <TabsList className="w-full" aria-label="Списки проектов">
            <TabsTrigger value="my-projects">Мои проекты</TabsTrigger>
            <TabsTrigger value="shared">Общие</TabsTrigger>
          </TabsList>
          <TabsContent value="my-projects" className="py-8 text-center text-muted-foreground">
            Проектов пока нет.
          </TabsContent>
          <TabsContent value="shared" className="py-8 text-center text-muted-foreground">
            Общих проектов пока нет.
          </TabsContent>
        </Tabs>
      )}

      {footer !== null && (
        <footer className="border-t border-sidebar-border p-4">
          {footer === undefined ? (
            <Button type="button" className="w-full">
              <Plus aria-hidden="true" />
              Новый проект
            </Button>
          ) : footer}
        </footer>
      )}
    </aside>
  )
}

export { ProjectSidebar }
export type { ProjectSidebarProps }
