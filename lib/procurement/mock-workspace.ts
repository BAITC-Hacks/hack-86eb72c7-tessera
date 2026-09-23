export type ScenarioId =
  | "ready" | "no-dataset" | "importing" | "invalid" | "running"
  | "success" | "no-need" | "failed" | "disconnected" | "degraded" | "cancelled";

export type SourceStatus = "ready" | "missing" | "checking" | "review";
export type Source = {
  id: string;
  label: string;
  status: SourceStatus;
  detail: string;
  required: boolean;
  affectedRows?: number;
  recovery?: string;
};

export type Dataset = {
  id: string;
  name: string;
  version: string;
  asOfDate: string;
  period: string;
  warehouses: { id: string; label: string }[];
  categories: string[];
  coverage: string;
  growth: string;
  sources: Source[];
  warnings: string[];
};

export type Scope = { warehouseId: string; category: string; asOfDate: string };
export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type Stage = "validate" | "forecast" | "recommend" | "explain";
export type StageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type ExplanationStatus = "not_requested" | "pending" | "succeeded" | "degraded";
export type DemoRun = {
  id: string;
  label: string;
  datasetId: string;
  scope: Scope;
  status: RunStatus;
  stage: Stage | null;
  stageStates: Record<Stage, StageStatus>;
  explanation: ExplanationStatus;
  updatedAt: string;
};

export type Fact = { label: string; value: string | null; note?: string };
export type Recommendation = {
  id: string;
  supplierId: string;
  supplier: string;
  sku: string;
  name: string;
  warehouseId: string;
  category: string;
  unit: string;
  recommended: string;
  step: string;
  urgency: "Срочно" | "Планово" | "Не требуется";
  summary: string;
  facts: Fact[];
  warnings: string[];
};

export type DemoProject = {
  id: string;
  name: string;
  dataset: Dataset | null;
  runs: DemoRun[];
  recommendations: Recommendation[];
};

export const scenarios: { id: ScenarioId; label: string }[] = [
  { id: "ready", label: "Данные готовы" },
  { id: "no-dataset", label: "Нет набора данных" },
  { id: "importing", label: "Импорт проверяется" },
  { id: "invalid", label: "Ошибки данных" },
  { id: "running", label: "Расчёт выполняется" },
  { id: "success", label: "Расчёт готов" },
  { id: "no-need", label: "Пополнение не требуется" },
  { id: "failed", label: "Ошибка расчёта" },
  { id: "disconnected", label: "Связь потеряна" },
  { id: "degraded", label: "ИИ-пояснение недоступно" },
  { id: "cancelled", label: "Расчёт отменён" },
];

const sources: Source[] = [
  { id: "sales", label: "История продаж", status: "ready", detail: "Синтетическая история за 2024–2026 годы", required: true },
  { id: "stock", label: "Остатки", status: "ready", detail: "Срез на 20.09.2026", required: true },
  { id: "transit", label: "Товары в пути", status: "ready", detail: "Два известных поступления; по одной позиции значение отсутствует", required: true },
  { id: "catalog", label: "Товары и категории", status: "ready", detail: "Сопоставлены 6 артикулов", required: true },
  { id: "suppliers", label: "Поставщики и сроки", status: "ready", detail: "Сроки из демонстрационного справочника", required: true },
  { id: "stockout", label: "Отсутствие товара", status: "review", detail: "История по одной позиции не подтверждена; резервное допущение указано в строке", required: false, affectedRows: 1, recovery: "Проверить интервалы отсутствия при реальном импорте" },
  { id: "growth", label: "Прогноз прироста", status: "ready", detail: "Предложенное допущение: план категории", required: false },
  { id: "bill", label: "Материальная ведомость 1С и сопоставление", status: "review", detail: "Демонстрационное сопоставление; формат выгрузки 1С не подтверждён", required: false, affectedRows: 2, recovery: "Сверить схему с владельцем 1С" },
];

const mainDataset: Dataset = {
  id: "dataset-main-v2", name: "Учебный складской срез", version: "v2", asOfDate: "2026-09-20",
  period: "01.01.2024 — 20.09.2026",
  warehouses: [{ id: "almaty", label: "Алматы" }, { id: "astana", label: "Астана" }],
  categories: ["Кабель", "Автоматика"], coverage: "45 дней (предложенное допущение)",
  growth: "План категории, источник: демонстрационный сценарий",
  sources,
  warnings: ["По одному артикулу история отсутствия товара неизвестна.", "Формат 1С и сопоставление требуют подтверждения."],
};

const secondaryDataset: Dataset = {
  ...mainDataset, id: "dataset-east-v1", name: "Учебный срез Восток", version: "v1",
  asOfDate: "2026-09-18", period: "01.01.2025 — 18.09.2026",
  sources: sources.map((source) => source.id === "stock" ? { ...source, detail: "Срез на 18.09.2026" } : { ...source }),
};

function factsFor(id: string, unit: string): Fact[] {
  const values: Record<string, { base: string; season: string; trend: string; growth: string; stockout: string | null; anomaly: string; target: string; stock: string; transit: string | null; result: string; step: string }> = {
    "r-001": { base: "18", season: "1,15", trend: "+6 %", growth: "+4 %", stockout: "3 наблюдённых дня; +2 шт. оценка", anomaly: "8", target: "31", stock: "9", transit: "4", result: "18", step: "1" },
    "r-002": { base: "14", season: "1,05", trend: "+3 %", growth: "+2 %", stockout: "0 подтверждённых дней; +0 шт. оценка", anomaly: "0", target: "20", stock: "5", transit: "3", result: "12", step: "1" },
    "r-003": { base: "12", season: "1,00", trend: "0 %", growth: "0 %", stockout: "0 подтверждённых дней; +0 шт. оценка", anomaly: "0", target: "20", stock: "18", transit: "2", result: "0", step: "1" },
    "r-004": { base: "90", season: "1,10", trend: "+7 %", growth: "+3 %", stockout: "2 наблюдённых дня; +5 м оценка", anomaly: "40", target: "150,5", stock: "20", transit: "5", result: "125,5", step: "0,5" },
    "r-005": { base: "34", season: "1,08", trend: "+2 %", growth: "+1 %", stockout: "0 подтверждённых дней; +0 м оценка", anomaly: "0", target: "50", stock: "8", transit: null, result: "42", step: "1" },
    "r-006": { base: "12", season: "1,00", trend: "+2 %", growth: "+1 %", stockout: null, anomaly: "0", target: "20", stock: "4", transit: "0", result: "16", step: "1" },
  };
  const item = values[id];
  return [
    { label: "Базовый регулярный спрос", value: `${item.base} ${unit} за 30 дней`, note: "История: 01.01.2024 — 20.09.2026" },
    { label: "Сезонность", value: `${item.season} ×`, note: "Осенний период; влияние показано отдельно" },
    { label: "Устойчивый тренд", value: item.trend, note: "Повторяющиеся продажи" },
    { label: "Прогноз прироста", value: item.growth, note: "Предложенное допущение категории; не дублирует тренд" },
    { label: "Отсутствие товара", value: item.stockout, note: item.stockout === null ? "История неизвестна; расчёт условный без компенсации" : "Наблюдение и оценка спроса разделены" },
    { label: "Исключённый разовый объём", value: `${item.anomaly} ${unit}`, note: item.anomaly === "0" ? "Исключений не обнаружено" : "Разовый заказ по обезличенной клиентской агрегации" },
    { label: "Горизонт и срок поставки", value: "45 + 12 дней", note: `Целевая потребность: ${item.target} ${unit}` },
    { label: "Остаток", value: `${item.stock} ${unit}` },
    { label: "В пути", value: item.transit === null ? null : `${item.transit} ${unit}`, note: item.transit === null ? "Факт неизвестен; условный расчёт использует явно заявленное допущение 0" : "Поступление в горизонте" },
    { label: "Итоговая рекомендация", value: `${item.result} ${unit}`, note: `Детерминированный результат по демонстрационным фактам; шаг ${item.step} ${unit}` },
  ];
}

export const demoRecommendations: Recommendation[] = [
  { id: "r-001", supplierId: "volta", supplier: "Вольта-Снаб", sku: "000174", name: "Автоматический выключатель 16 А", warehouseId: "almaty", category: "Автоматика", unit: "шт.", recommended: "18", step: "1", urgency: "Срочно", summary: "Сезонность, тренд и 3 дня отсутствия товара", facts: factsFor("r-001", "шт."), warnings: [] },
  { id: "r-002", supplierId: "volta", supplier: "Вольта-Снаб", sku: "000208", name: "Контактор модульный 25 А", warehouseId: "almaty", category: "Автоматика", unit: "шт.", recommended: "12", step: "1", urgency: "Планово", summary: "Стабильный спрос и подтверждённый объём в пути", facts: factsFor("r-002", "шт."), warnings: [] },
  { id: "r-003", supplierId: "volta", supplier: "Вольта-Снаб", sku: "000311", name: "Реле промежуточное", warehouseId: "almaty", category: "Автоматика", unit: "шт.", recommended: "0", step: "1", urgency: "Не требуется", summary: "Остаток покрывает целевую потребность", facts: factsFor("r-003", "шт."), warnings: [] },
  { id: "r-004", supplierId: "cable", supplier: "КабельПром", sku: "000047", name: "Кабель силовой ВВГнг 3×2,5", warehouseId: "almaty", category: "Кабель", unit: "м", recommended: "125.5", step: "0.5", urgency: "Срочно", summary: "Рост спроса и исключён разовый объём", facts: factsFor("r-004", "м"), warnings: [] },
  { id: "r-005", supplierId: "cable", supplier: "КабельПром", sku: "000052", name: "Провод монтажный ПВ-3", warehouseId: "almaty", category: "Кабель", unit: "м", recommended: "42", step: "1", urgency: "Планово", summary: "Условный расчёт: объём в пути неизвестен", facts: factsFor("r-005", "м"), warnings: ["Объём в пути не подтверждён; число условное при явно указанном допущении."] },
  { id: "r-006", supplierId: "cable", supplier: "КабельПром", sku: "000061", name: "Кабель контрольный КВВГ", warehouseId: "almaty", category: "Кабель", unit: "м", recommended: "16", step: "1", urgency: "Планово", summary: "Условный расчёт без истории отсутствия товара", facts: factsFor("r-006", "м"), warnings: ["История отсутствия товара не загружена; расчёт условный."] },
];

const successStages: DemoRun["stageStates"] = { validate: "succeeded", forecast: "succeeded", recommend: "succeeded", explain: "succeeded" };

export const initialProjects: DemoProject[] = [
  {
    id: "demo-almaty", name: "Учебные закупки · Алматы", dataset: mainDataset,
    runs: [
      { id: "run-a1", label: "Расчёт от 20.09.2026", datasetId: mainDataset.id, scope: { warehouseId: "almaty", category: "all", asOfDate: mainDataset.asOfDate }, status: "succeeded", stage: "explain", stageStates: successStages, explanation: "succeeded", updatedAt: "2026-09-20T10:30:00+05:00" },
      { id: "run-a0", label: "Предыдущий расчёт", datasetId: mainDataset.id, scope: { warehouseId: "almaty", category: "Кабель", asOfDate: "2026-09-10" }, status: "failed", stage: "forecast", stageStates: { validate: "succeeded", forecast: "failed", recommend: "pending", explain: "pending" }, explanation: "not_requested", updatedAt: "2026-09-10T11:00:00+05:00" },
    ], recommendations: demoRecommendations,
  },
  {
    id: "demo-astana", name: "Учебные закупки · Астана", dataset: secondaryDataset,
    runs: [
      { id: "run-b1", label: "Расчёт от 18.09.2026", datasetId: secondaryDataset.id, scope: { warehouseId: "astana", category: "all", asOfDate: secondaryDataset.asOfDate }, status: "succeeded", stage: "explain", stageStates: successStages, explanation: "succeeded", updatedAt: "2026-09-18T09:10:00+05:00" },
    ], recommendations: demoRecommendations.slice(0, 3).map((row) => ({ ...row, id: `east-${row.id}`, warehouseId: "astana" })),
  },
];

export function sourcesForScenario(dataset: Dataset | null, scenario: ScenarioId): Source[] {
  if (!dataset || scenario === "no-dataset") return [];
  if (scenario === "importing") return dataset.sources.map((source) => source.id === "sales" ? { ...source, status: "checking", detail: "Проверка демонстрационного источника" } : source);
  if (scenario === "invalid") return dataset.sources.map((source) => source.id === "sales" ? { ...source, status: "review", detail: "Не сопоставлена колонка количества", affectedRows: 12, recovery: "Исправить сопоставление и повторить импорт (демо)" } : source);
  return dataset.sources;
}

export function dataReady(dataset: Dataset | null, scenario: ScenarioId): boolean {
  if (!dataset || scenario === "no-dataset") return false;
  return !sourcesForScenario(dataset, scenario).some((source) => source.required && source.status !== "ready");
}
