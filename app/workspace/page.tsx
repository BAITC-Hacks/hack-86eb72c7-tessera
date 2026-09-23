import type { Metadata } from "next";
import { ProcurementWorkspace } from "@/components/procurement/procurement-workspace";

export const metadata: Metadata = {
  title: "Рабочее место закупок · Tessera",
  description: "Демонстрационное рабочее место менеджера закупок",
};

export default function WorkspacePage() {
  return <ProcurementWorkspace />;
}
