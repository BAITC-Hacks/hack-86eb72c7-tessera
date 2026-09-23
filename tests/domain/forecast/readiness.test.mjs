import '../load-typescript.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { ForecastResultSchema } = await import('../../../lib/contracts/calculation.ts');
const { forecastDemand, sumDailyForecast } = await import('../../../lib/domain/forecast/index.ts');
const {
  decimal, makeConfiguration, makeDataset, makeSale, makeStockout, scope, uuid, validateDataset,
} = await import('../../fixtures/forecast/index.mjs');

function forecast(dataset, configuration = makeConfiguration()) {
  validateDataset(dataset);
  return ForecastResultSchema.parse(forecastDemand(dataset, scope, configuration));
}
function knownSeries(result) {
  assert.equal(result.series.length, 1);
  assert.equal(result.series[0].status, 'known', JSON.stringify(result.warnings));
  assert.ok(result.series[0].model);
  return result.series[0];
}
function horizon(result) {
  return sumDailyForecast(knownSeries(result).model, '2025-09-01', '2025-09-30');
}
function close(actual, expected, epsilon = 1e-5) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≠ ${expected}`);
}
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
function salesCount(dataset) {
  dataset.version.sourceCompleteness.find((item) => item.sourceType === 'sales').rowCount = dataset.sales.length;
  return dataset;
}

// M2–M4 — воспроизводимые проверки методики, не оценка данных партнёра.
test('повтор, перестановка строк и неизменяемость входа', () => {
  const dataset = makeDataset({ startDate: '2025-01-01' });
  const original = structuredClone(dataset);
  const configuration = deepFreeze(makeConfiguration());
  const first = forecast(deepFreeze(dataset), configuration);
  assert.deepEqual(forecast(dataset, configuration), first);
  assert.deepEqual(dataset, original);
  const reordered = structuredClone(original);
  reordered.sales.reverse();
  reordered.version.sourceCompleteness.reverse();
  assert.deepEqual(forecast(reordered, configuration), first);
  close(horizon(first), 300);
});

test('разбиение одного документа на строки не меняет модель и числовые итоги', () => {
  const dataset = makeDataset({ startDate: '2025-01-01' });
  const split = structuredClone(dataset);
  split.sales = dataset.sales.flatMap((sale, index) => [
    { ...sale, id: uuid(300_000 + index * 2), quantity: '4', sourceRowNumber: index * 2 + 1 },
    { ...sale, id: uuid(300_001 + index * 2), quantity: '6', sourceRowNumber: index * 2 + 2 },
  ]);
  salesCount(split);
  const original = knownSeries(forecast(dataset));
  const divided = knownSeries(forecast(split));
  assert.deepEqual(divided.model, original.model);
  for (const key of ['rawSalesQty', 'excludedOutlierQty', 'stockoutCompensationQty', 'baseAnchor']) {
    assert.equal(divided.evidence[key], original.evidence[key]);
  }
});

test('M2: повторяющийся сезонный пик выше обычного месяца и не исключается', () => {
  const result = forecast(makeDataset({ quantityForDay: (date) => date.slice(5, 7) === '12' ? 100 : 10 }));
  const series = knownSeries(result);
  assert.equal(series.evidence.seasonality.source, 'estimated');
  assert.ok(series.evidence.seasonality.fullCyclesUsed >= 2);
  assert.equal(series.evidence.excludedOutlierQty, '0');
  const ordinary = sumDailyForecast(series.model, '2025-09-01', '2025-09-30') / 30;
  const peak = sumDailyForecast(series.model, '2025-12-01', '2025-12-31') / 31;
  assert.ok(peak > ordinary * 8, `${peak} против ${ordinary}`);
});

test('M2: устойчивый рост повышает прогноз, единичный всплеск — нет', () => {
  const flat = forecast(makeDataset({ startDate: '2025-01-01' }), makeConfiguration({ seasonalityMode: 'none' }));
  const growing = makeDataset({
    startDate: '2025-01-01',
    quantityForDay: (date) => date < '2025-01-01' ? 10 : 10 * 1.1 ** (Number(date.slice(5, 7)) - 1),
  });
  const trend = forecast(growing, makeConfiguration({ seasonalityMode: 'none' }));
  assert.ok(horizon(trend) > horizon(flat) * 1.3);
  assert.ok(Number(knownSeries(trend).model.trendMonthlyFactor) > 1);
  const spike = makeDataset({ startDate: '2025-01-01', quantityForDay: (date) => date === '2025-08-25' ? 1000 : 10 });
  const isolated = forecast(spike, makeConfiguration({ seasonalityMode: 'none' }));
  assert.ok(Math.abs(horizon(isolated) / horizon(flat) - 1) <= 0.05);
  assert.ok(Number(knownSeries(isolated).evidence.excludedOutlierQty) >= 900);
});

test('M4: событие 100× и его разбиение по документам клиента меняют спрос не более 5%', () => {
  const configuration = makeConfiguration({ seasonalityMode: 'none' });
  const baseline = horizon(forecast(makeDataset({ startDate: '2025-01-01' }), configuration));
  for (const documents of [1, 20]) {
    const dataset = makeDataset({ startDate: '2025-01-01' });
    dataset.sales.push(...Array.from({ length: documents }, (_, index) => makeSale({
      id: uuid(400_000 + index), sourceRowNumber: 400_000 + index,
      sourceEventId: `synthetic-anomaly-${index}`, quantity: decimal(1000 / documents),
      soldOn: '2025-08-25', anonymousCustomerKey: 'anon_regular',
    })));
    const result = forecast(salesCount(dataset), configuration);
    assert.ok(Math.abs(horizon(result) / baseline - 1) <= 0.05, `${documents} документов`);
    const evidence = knownSeries(result).evidence;
    assert.ok(Number(evidence.excludedOutlierQty) >= 900);
    assert.ok(evidence.outlierExclusions.length > 0);
    const excluded = evidence.outlierExclusions.reduce((sum, row) => sum + Number(row.excludedQty), 0);
    close(excluded, Number(evidence.excludedOutlierQty));
    for (const row of evidence.outlierExclusions) {
      close(Number(row.rawQty) - Number(row.excludedQty), Number(row.regularQty));
      assert.ok(row.sourceRefs.length > 0);
    }
    if (documents > 1) assert.ok(evidence.outlierExclusions.some((row) => row.level === 'customer_week'));
  }
});

test('M4: постоянный крупный клиент сохраняет регулярный объём', () => {
  const dataset = makeDataset({ startDate: '2025-01-01' });
  dataset.sales.push(...dataset.sales.map((sale, index) => ({
    ...sale, id: uuid(500_000 + index), sourceRowNumber: 500_000 + index,
    sourceEventId: `large-${sale.sourceEventId}`, quantity: '100', anonymousCustomerKey: 'anon_large_regular',
  })));
  const result = forecast(salesCount(dataset), makeConfiguration({ seasonalityMode: 'none' }));
  assert.equal(knownSeries(result).evidence.excludedOutlierQty, '0');
  close(horizon(result), 3300);
});

test('M3: stockout восстанавливает спрос; пересекающиеся полуинтервалы учитываются один раз', () => {
  const quantityForDay = (date) => date >= '2025-07-01' ? 0 : 10;
  const raw = makeDataset({ quantityForDay });
  const single = makeDataset({ quantityForDay, stockouts: [makeStockout('2025-07-01', '2025-09-01')] });
  const overlapping = makeDataset({ quantityForDay, stockouts: [
    makeStockout('2025-07-01', '2025-08-15'),
    makeStockout('2025-08-01', '2025-09-01', { id: uuid(200_001), sourceRowNumber: 200_001 }),
  ] });
  const configuration = makeConfiguration({ seasonalityMode: 'none' });
  const rawResult = forecast(raw, configuration);
  const restored = forecast(single, configuration);
  const overlapResult = forecast(overlapping, configuration);
  assert.ok(horizon(restored) > horizon(rawResult));
  close(horizon(restored), horizon(overlapResult));
  close(Number(knownSeries(restored).evidence.stockoutCompensationQty), 620);
  close(Number(knownSeries(overlapResult).evidence.stockoutCompensationQty), 620);
  const adjustments = knownSeries(overlapResult).evidence.stockoutAdjustments;
  assert.equal(adjustments.reduce((sum, item) => sum + item.days, 0), 62);
  assert.ok(adjustments.every((item) => item.quality === 'estimated'));
});

test('M3: отсутствие сопоставимых доступных дней явно ограничивает результат', () => {
  const dataset = makeDataset({
    startDate: '2025-08-01', quantity: 0,
    stockouts: [makeStockout('2025-08-01', '2025-09-01')],
  });
  const result = forecast(dataset);
  assert.equal(result.coverage.coverageGate, 'incomplete');
  assert.equal(result.coverage.canApprove, false);
  assert.ok(result.warnings.some((item) => item.code === 'stockout_insufficient_evidence'));
  assert.ok(result.series[0].evidence.stockoutAdjustments.some((item) => item.quality === 'insufficient_evidence'));
  assert.equal(result.series[0].evidence.stockoutCompensationQty, '0');
});

test('события после среза не влияют на модель, доказательства и предупреждения', () => {
  const original = makeDataset({ startDate: '2025-01-01', stockouts: [makeStockout('2027-01-01', '2027-02-01')] });
  const future = structuredClone(original);
  future.sales.push(makeSale({ soldOn: '2026-01-01', quantity: '9999999' }));
  future.stockoutIntervals.push(makeStockout('2026-01-01', '2026-02-01', { id: uuid(200_001) }));
  assert.deepEqual(forecast(future), forecast(original));
});

test('сравнение с простым средним на известном синтетическом сезонном holdout', (t) => {
  const dataset = makeDataset({ quantityForDay: (date) => date.slice(5, 7) === '12' ? 30 : 10 });
  const series = knownSeries(forecast(dataset));
  const actual = 30 * 31;
  const predicted = sumDailyForecast(series.model, '2025-12-01', '2025-12-31');
  const naive = dataset.sales.reduce((sum, item) => sum + Number(item.quantity), 0) / dataset.sales.length * 31;
  const modelAbsoluteError = Math.abs(predicted - actual);
  const meanAbsoluteError = Math.abs(naive - actual);
  assert.ok(modelAbsoluteError < meanAbsoluteError);
  t.diagnostic(JSON.stringify({ scenario: 'synthetic_december_holdout', actual, predicted, naive,
    modelAbsoluteError, meanAbsoluteError, limitation: 'Один синтетический сценарий, не промышленная оценка точности' }));
});
