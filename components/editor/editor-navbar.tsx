"use client"

import { PanelLeftClose, PanelLeftOpen } from "lucide-react"

import { Button } from "@/components/ui/button"

interface EditorNavbarProps {
  isSidebarOpen: boolean
  onToggleSidebar: () => void
  sidebarId?: string
}

function EditorNavbar({
  isSidebarOpen,
  onToggleSidebar,
  sidebarId,
}: EditorNavbarProps) {
  const SidebarIcon = isSidebarOpen ? PanelLeftClose : PanelLeftOpen

  return (
    <header className="relative z-30 grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center border-b border-border bg-background px-4 text-foreground">
      <div className="flex items-center justify-start">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={isSidebarOpen ? "Close sidebar" : "Open sidebar"}
          aria-expanded={isSidebarOpen}
          aria-controls={sidebarId}
          onClick={onToggleSidebar}
        >
          <SidebarIcon aria-hidden="true" />
        </Button>
      </div>
      <div className="flex items-center justify-center" />
      <div className="flex items-center justify-end" />
    </header>
  )
}

export { EditorNavbar }
export type { EditorNavbarProps }
