"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Dataset, Source } from "@/lib/procurement/mock-workspace";

const statusLabels = { ready: "Готово", missing: "Не загружено", checking: "Проверяется", review: "Требует проверки" };

type Props = { dataset: Dataset | null; sources: Source[]; ready: boolean; onShowValidation: () => void };

export function DataReadinessPanel({ dataset, sources, ready, onShowValidation }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileInfo, setFileInfo] = useState<string | null>(null);

  return (
    <section aria-labelledby="readiness-heading" className="rounded-lg border border-border bg-card p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="readiness-heading" className="text-base font-semibold">Готовность данных</h2>
          <p className="mt-1 text-sm text-muted-foreground">{dataset ? `${dataset.name} · ${dataset.version} · срез ${dataset.asOfDate}` : "Набор данных не выбран"}</p>
        </div>
        <span className="rounded-md border border-border px-2 py-1 text-xs">{ready ? "Обязательные источники готовы" : "Расчёт заблокирован"}</span>
      </div>
      {dataset ? (
        <ul className="mt-4 grid gap-x-5 gap-y-3 sm:grid-cols-2">
          {sources.map((source) => (
            <li key={source.id} className="border-t border-border pt-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{source.label}</span>
                <span className="text-xs text-muted-foreground">{statusLabels[source.status]}</span>
              </div>
              <p className="mt-1 text-muted-foreground">{source.detail}</p>
              {source.affectedRows !== undefined && <p className="mt-1">Затронуто строк: {source.affectedRows}. {source.recovery}</p>}
            </li>
          ))}
        </ul>
      ) : <p className="mt-4 text-sm text-muted-foreground">Создайте или выберите набор в будущем импорте. Здесь доступен только сценарий демо.</p>}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <input ref={inputRef} type="file" accept=".csv,.xls,.xlsx" className="sr-only" aria-label="Выбрать файл для демонстрации" onChange={(event) => {
          const file = event.target.files?.[0];
          setFileInfo(file ? `${file.name} · ${new Intl.NumberFormat("ru-RU").format(file.size)} байт` : null);
        }} />
        <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>Выбрать файл (демо)</Button>
        <Button type="button" variant="outline" onClick={onShowValidation}>Показать проверку (демо)</Button>
      </div>
      {fileInfo && <p className="mt-2 text-sm">Выбран файл: {fileInfo}</p>}
      <p className="mt-2 text-xs text-muted-foreground">Файл не загружается; результат проверки демонстрационный.</p>
    </section>
  );
}
