import {
  CategoryPolicySchema, DatasetVersionSchema, GrowthAssumptionSchema, InboundShipmentSchema,
  MonthlySalesSchema, ProductSchema, ProductSupplierSchema, SaleSchema, SeasonalityIndexSchema,
  SourceTypeSchema, StockoutIntervalSchema, StockSnapshotSchema, SupplierLeadTimeSchema,
  SupplierSchema, WarehouseSchema,
} from '../../../lib/contracts/datasets.ts';
import { CalculationPoliciesSchema } from '../../../lib/contracts/calculation.ts';
import { ImportManifestSchema } from '../../../lib/contracts/imports.ts';
import { RunConfigurationSchema } from '../../../lib/contracts/runs.ts';

// Только синтетические данные: фиксированные UUID, даты и обезличенные ключи.
export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ids = {
  project: uuid(1), version: uuid(2), import: uuid(3), source: uuid(4),
  product: uuid(5), warehouse: uuid(6), supplier: uuid(7), category: 'synthetic-category',
};
export const scope = { warehouseIds: [], categoryIds: [] };
const createdAt = '2025-09-01T00:00:00.000Z';
const hash = 'a'.repeat(64);
const entity = (id) => ({ id, projectId: ids.project, datasetVersionId: ids.version });
const observation = (id, row = 1) => ({
  ...entity(id), productId: ids.product, warehouseId: ids.warehouse,
  sourceObjectId: ids.source, sourceSheet: 'sales', sourceRowNumber: row,
});
export const decimal = (value) => Number(value).toFixed(8).replace(/\.?0+$/, '') || '0';
export const nextDay = (date) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export function makeConfiguration(runOverrides = {}, policyOverrides = {}) {
  return {
    run: RunConfigurationSchema.parse({
      runMode: 'diagnostic', scope, asOfDate: '2025-08-31', historicalWindowMonths: 36,
      minComparableWeeks: 8, outlierMadMultiplier: '6', outlierMedianMultiplier: '5',
      zeroMadMinimumUnit: '1', incompleteMonthPolicy: 'exclude', growthMode: 'none',
      seasonalityMode: 'estimated', reviewPeriodDays: 30, safetyDaysByCategory: [],
      leadTimePolicyVersion: 'synthetic-v1', unitPolicyVersion: 'synthetic-v1',
      algorithmVersion: 'forecast-v1', parametersHash: hash, ...runOverrides,
    }),
    policies: CalculationPoliciesSchema.parse({
      trendCapsByCategory: [{ categoryKey: ids.category, maxMonthlyTrendFactor: '2' }],
      unitSteps: [{ productId: ids.product, unit: 'pcs', step: '1' }],
      growthSemanticsByAssumption: [], ...policyOverrides,
    }),
  };
}

export function makeSale(overrides = {}) {
  return SaleSchema.parse({
    ...observation(uuid(100_000), 100_000), soldOn: '2025-08-25', quantity: '10', unit: 'pcs',
    operationType: 'sale', sourceEventId: 'synthetic-extra', unitPrice: null,
    anonymousCustomerKey: 'anon_regular', customerKeyAvailable: true, ...overrides,
  });
}

export function makeStockout(startsOn, endsOn, overrides = {}) {
  return StockoutIntervalSchema.parse({
    ...observation(uuid(200_000), 200_000), startsOn, endsOn, status: 'observed', ...overrides,
  });
}

const rowSchemas = {
  products: ProductSchema, warehouses: WarehouseSchema, suppliers: SupplierSchema,
  productSuppliers: ProductSupplierSchema, sales: SaleSchema, monthlySales: MonthlySalesSchema,
  stockSnapshots: StockSnapshotSchema, inboundShipments: InboundShipmentSchema,
  stockoutIntervals: StockoutIntervalSchema, categoryPolicies: CategoryPolicySchema,
  growthAssumptions: GrowthAssumptionSchema, supplierLeadTimes: SupplierLeadTimeSchema,
  seasonalityIndices: SeasonalityIndexSchema,
};

export function validateDataset(dataset) {
  DatasetVersionSchema.parse(dataset.version);
  for (const [key, schema] of Object.entries(rowSchemas)) {
    for (const row of dataset[key]) schema.parse(row);
  }
  return dataset;
}

export function makeDataset({
  startDate = '2023-01-01', endDate = '2025-08-31', quantity = 10,
  quantityForDay = () => quantity, stockouts = [],
} = {}) {
  const sales = [];
  for (let date = startDate, index = 0; date <= endDate; date = nextDay(date), index += 1) {
    sales.push(makeSale({
      id: uuid(1000 + index), soldOn: date, quantity: decimal(quantityForDay(date, index)),
      sourceEventId: `synthetic-${date}`, sourceRowNumber: index + 1,
    }));
  }
  const sourceCounts = {
    sales: sales.length, stock: 1, suppliers: 1, categories: 1,
    product_mapping: 1, lead_times: 1, stockouts: stockouts.length,
  };
  const sourceCompleteness = SourceTypeSchema.options.map((sourceType) => ({
    sourceType, status: sourceCounts[sourceType] ? 'complete' : 'explicit_none',
    rowCount: sourceCounts[sourceType] || 0, reasonCode: null,
    confirmedByUserId: sourceCounts[sourceType] ? null : 'synthetic-author',
    confirmationReason: sourceCounts[sourceType] ? null : 'В синтетическом сценарии источник явно отсутствует',
  }));
  const importMetadata = ImportManifestSchema.parse({
    projectId: ids.project, asOfDate: endDate, adapterVersion: 'synthetic-v1', schemaVersion: 'v1',
    forecastBasis: 'transactions', sources: [{
      sourceObjectId: ids.source, checksum: hash, sourceType: 'sales', namespace: 'synthetic',
      format: 'generic', origin: 'synthetic', sheet: 'sales', mappingVersion: 'v1',
      exportedAt: createdAt, period: { startDate, endDate: nextDay(endDate) },
      periodCompleteness: 'complete', unit: 'pcs', completeness: 'complete',
      confirmedByUserId: null, confirmationReason: null,
      columnMappings: [{ sourceColumn: 'quantity', targetField: 'quantity' }],
      priority: 0, correctionReason: null, headerRow: 1,
      semantics: { operationType: 'sale', growth: 'unresolved', seasonality: 'unresolved', quantitySign: 'preserve' },
    }],
  });
  return validateDataset({
    version: {
      id: ids.version, projectId: ids.project, importId: ids.import,
      schemaVersion: 'v1', asOfDate: endDate, provenance: 'synthetic', manifestHash: hash,
      manifest: [{ sourceType: 'sales', sourceObjectId: ids.source, checksum: hash,
        origin: 'synthetic', sheet: 'sales', mappingVersion: 'v1', columnMappings: [], importMetadata }],
      sourceCompleteness, createdAt,
    },
    products: [{ ...entity(ids.product), sourceKey: 'synthetic-product', sku: '00001',
      name: 'Синтетический товар', unit: 'pcs', categoryKey: ids.category, conversions: [], createdAt }],
    warehouses: [{ ...entity(ids.warehouse), sourceKey: 'synthetic-warehouse', name: 'Синтетический склад', createdAt }],
    suppliers: [{ ...entity(ids.supplier), sourceKey: 'synthetic-supplier', name: 'Синтетический поставщик', createdAt }],
    productSuppliers: [{ ...entity(uuid(8)), productId: ids.product, supplierId: ids.supplier,
      supplierSku: null, moq: null, packMultiple: null, conversion: null }],
    sales, monthlySales: [],
    stockSnapshots: [{ ...observation(uuid(9)), asOfDate: endDate, quantity: '100', unit: 'pcs' }],
    inboundShipments: [], stockoutIntervals: stockouts,
    categoryPolicies: [{ ...entity(uuid(10)), categoryKey: ids.category, reviewPeriodDays: 30,
      safetyStock: null, parameters: { reviewPeriodDays: 30, safetyStock: null, safetyDays: 0 }, policyVersion: 'v1' }],
    growthAssumptions: [],
    supplierLeadTimes: [{ ...entity(uuid(11)), supplierId: ids.supplier, productId: ids.product,
      categoryKey: null, days: 7, provenance: 'synthetic' }],
    seasonalityIndices: [],
  });
}
