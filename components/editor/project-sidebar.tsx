"use client"

import { Plus, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

type ProjectSidebarProps = {
  isOpen: boolean
  onClose: () => void
}

function ProjectSidebar({ isOpen, onClose }: ProjectSidebarProps) {
  return (
    <aside
      aria-label="Projects"
      aria-hidden={!isOpen}
      inert={!isOpen}
      className={cn(
        "fixed top-16 bottom-2 left-2 z-40 flex w-80 max-w-[calc(100vw-1rem)] flex-col rounded-xl border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-lg transition-transform duration-200 ease-out motion-reduce:transition-none",
        isOpen ? "translate-x-0" : "pointer-events-none -translate-x-[calc(100%+1rem)]"
      )}
    >
      <header className="flex items-center justify-between border-b border-sidebar-border p-4">
        <h2 className="text-sm font-semibold">Projects</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close project sidebar"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>

      <Tabs defaultValue="my-projects" className="min-h-0 flex-1 overflow-y-auto p-4">
        <TabsList className="w-full" aria-label="Project lists">
          <TabsTrigger value="my-projects">My Projects</TabsTrigger>
          <TabsTrigger value="shared">Shared</TabsTrigger>
        </TabsList>
        <TabsContent value="my-projects" className="py-8 text-center text-muted-foreground">
          No projects yet.
        </TabsContent>
        <TabsContent value="shared" className="py-8 text-center text-muted-foreground">
          No shared projects yet.
        </TabsContent>
      </Tabs>

      <footer className="border-t border-sidebar-border p-4">
        <Button type="button" className="w-full">
          <Plus aria-hidden="true" />
          New Project
        </Button>
      </footer>
    </aside>
  )
}

export { ProjectSidebar }
export type { ProjectSidebarProps }
