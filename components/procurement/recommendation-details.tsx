import type { Recommendation } from "@/lib/procurement/mock-workspace";

export function RecommendationDetails({ row, degraded }: { row: Recommendation; degraded: boolean }) {
  return (
    <div className="space-y-4 rounded-md bg-muted/40 p-4">
      <div>
        <h4 className="text-sm font-semibold">Числовая расшифровка · {row.sku}</h4>
        <p className="mt-1 text-sm text-muted-foreground">Детерминированное обоснование: {row.summary}.</p>
        {degraded && <p className="mt-1 text-xs text-muted-foreground">ИИ-пояснение недоступно; числовые факты сохранены.</p>}
      </div>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {row.facts.map((fact) => (
          <div key={fact.label} className="border-t border-border pt-2 text-sm">
            <dt className="font-medium">{fact.label}</dt>
            <dd className="mt-1 tabular-nums">{fact.value ?? "Нет данных"}</dd>
            {fact.note && <dd className="mt-1 text-xs text-muted-foreground">{fact.note}</dd>}
          </div>
        ))}
      </dl>
      {row.warnings.map((warning) => <p key={warning} className="text-sm">Оговорка: {warning}</p>)}
    </div>
  );
}
