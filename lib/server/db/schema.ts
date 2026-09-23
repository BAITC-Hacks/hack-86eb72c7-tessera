import { pgTable, text, timestamp, unique, check, uuid, foreignKey, integer, jsonb, date, numeric, smallint, boolean } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const schemaMigrations = pgTable("schema_migrations", {
	name: text().primaryKey().notNull(),
	checksum: text().notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const projects = pgTable("projects", {
	id: uuid().primaryKey().notNull(),
	ownerUserId: text("owner_user_id").notNull(),
	name: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	archivedAt: timestamp("archived_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	unique("projects_id_owner_user_id_key").on(table.id, table.ownerUserId),
	check("projects_owner_user_id_check", sql`length(owner_user_id) > 0`),
	check("projects_name_check", sql`length(TRIM(BOTH FROM name)) > 0`),
]);

export const sourceObjects = pgTable("source_objects", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	objectKey: text("object_key").notNull(),
	checksum: text().notNull(),
	byteSize: integer("byte_size").notNull(),
	contentType: text("content_type").notNull(),
	purpose: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "source_objects_project_id_fkey"
		}),
	unique("source_objects_object_key_key").on(table.objectKey),
	unique("source_objects_project_id_id_key").on(table.id, table.projectId),
	unique("source_objects_project_id_id_checksum_key").on(table.checksum, table.id, table.projectId),
	unique("source_objects_project_id_checksum_key").on(table.checksum, table.projectId),
	check("source_objects_checksum_check", sql`checksum ~ '^[a-f0-9]{64}$'::text`),
	check("source_objects_byte_size_check", sql`(byte_size >= 1) AND (byte_size <= 26214400)`),
	check("source_objects_purpose_check", sql`purpose = ANY (ARRAY['source'::text, 'report'::text, 'export'::text])`),
	check("source_objects_check", sql`object_key = ((((('projects/'::text || (project_id)::text) || '/'::text) || purpose) || 's/'::text) || (id)::text)`),
	check("source_objects_check1", sql`((purpose = 'source'::text) AND (content_type = ANY (ARRAY['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'::text, 'text/csv'::text, 'application/zip'::text]))) OR ((purpose = 'report'::text) AND (content_type = ANY (ARRAY['application/json'::text, 'text/csv'::text]))) OR ((purpose = 'export'::text) AND (content_type = 'text/csv'::text))`),
]);

export const imports = pgTable("imports", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	sourceObjectId: uuid("source_object_id").notNull(),
	checksum: text().notNull(),
	manifest: jsonb().notNull(),
	manifestHash: text("manifest_hash").notNull(),
	manifestFrozen: boolean("manifest_frozen").default(true).notNull(),
	adapterVersion: text("adapter_version").notNull(),
	schemaVersion: text("schema_version").notNull(),
	status: text().notNull(),
	qualityReport: jsonb("quality_report"),
	reportObjectId: uuid("report_object_id"),
	reportChecksum: text("report_checksum"),
	publicationManifest: jsonb("publication_manifest"),
	publicationManifestHash: text("publication_manifest_hash"),
	safeError: text("safe_error"),
	stateVersion: integer("state_version").default(0).notNull(),
	datasetVersionId: uuid("dataset_version_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	// Cyclic deferred import-to-dataset FK is defined in the SQL migration.
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "imports_project_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.sourceObjectId, table.checksum],
			foreignColumns: [sourceObjects.projectId, sourceObjects.id, sourceObjects.checksum],
			name: "imports_project_id_source_object_id_checksum_fkey"
		}),
	unique("imports_project_id_id_key").on(table.id, table.projectId),
	unique("imports_project_id_checksum_manifest_hash_adapter_version_s_key").on(table.adapterVersion, table.checksum, table.manifestHash, table.projectId, table.schemaVersion),
	check("imports_manifest_hash_check", sql`manifest_hash ~ '^[a-f0-9]{64}$'::text`),
	check("imports_status_check", sql`status = ANY (ARRAY['uploaded'::text, 'awaiting-validation'::text, 'validating'::text, 'needs_mapping'::text, 'invalid'::text, 'ready'::text, 'failed'::text])`),
	check("imports_state_version_check", sql`state_version >= 0`),
	check("imports_report_pair_check", sql`(report_object_id IS NULL) = (report_checksum IS NULL)`),
	check("imports_report_checksum_check", sql`report_checksum ~ '^[a-f0-9]{64}$'`),
	check("imports_publication_pair_check", sql`(publication_manifest IS NULL) = (publication_manifest_hash IS NULL)`),
	check("imports_publication_manifest_check", sql`jsonb_typeof(publication_manifest) = 'array'`),
	check("imports_publication_hash_check", sql`publication_manifest_hash ~ '^[a-f0-9]{64}$'`),
	foreignKey({
		columns: [table.projectId, table.reportObjectId, table.reportChecksum],
		foreignColumns: [sourceObjects.projectId, sourceObjects.id, sourceObjects.checksum],
		name: "imports_report_object_fkey",
	}),
]);

export const datasetVersions = pgTable("dataset_versions", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	importId: uuid("import_id").notNull(),
	manifest: jsonb().notNull(),
	manifestHash: text("manifest_hash").notNull(),
	asOfDate: date("as_of_date").notNull(),
	provenance: text().notNull(),
	sourceCompleteness: jsonb("source_completeness").notNull(),
	schemaVersion: text("schema_version").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.importId],
			foreignColumns: [imports.projectId, imports.id],
			name: "dataset_versions_project_id_import_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "dataset_versions_project_id_fkey"
		}),
	unique("dataset_versions_project_id_id_key").on(table.id, table.projectId),
	unique("dataset_versions_project_id_import_id_id_key").on(table.id, table.importId, table.projectId),
	check("dataset_versions_manifest_hash_check", sql`manifest_hash ~ '^[a-f0-9]{64}$'::text`),
	check("dataset_versions_provenance_check", sql`provenance = ANY (ARRAY['partner'::text, 'synthetic'::text, 'mixed'::text])`),
]);

export const suppliers = pgTable("suppliers", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	sourceKey: text("source_key").notNull(),
	name: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.datasetVersionId],
			foreignColumns: [datasetVersions.projectId, datasetVersions.id],
			name: "suppliers_project_id_dataset_version_id_fkey"
		}),
	unique("suppliers_project_id_dataset_version_id_id_key").on(table.datasetVersionId, table.id, table.projectId),
	unique("suppliers_project_id_dataset_version_id_source_key_key").on(table.datasetVersionId, table.projectId, table.sourceKey),
]);

export const warehouses = pgTable("warehouses", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	sourceKey: text("source_key").notNull(),
	name: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.datasetVersionId],
			foreignColumns: [datasetVersions.projectId, datasetVersions.id],
			name: "warehouses_project_id_dataset_version_id_fkey"
		}),
	unique("warehouses_project_id_dataset_version_id_id_key").on(table.datasetVersionId, table.id, table.projectId),
	unique("warehouses_project_id_dataset_version_id_source_key_key").on(table.datasetVersionId, table.projectId, table.sourceKey),
]);

export const products = pgTable("products", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	sourceKey: text("source_key").notNull(),
	sku: text().notNull(),
	name: text().notNull(),
	unit: text().notNull(),
	categoryKey: text("category_key").notNull(),
	conversions: jsonb().default([]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.datasetVersionId],
			foreignColumns: [datasetVersions.projectId, datasetVersions.id],
			name: "products_project_id_dataset_version_id_fkey"
		}),
	unique("products_project_id_dataset_version_id_id_key").on(table.datasetVersionId, table.id, table.projectId),
	unique("products_project_id_dataset_version_id_source_key_key").on(table.datasetVersionId, table.projectId, table.sourceKey),
	unique("products_project_id_dataset_version_id_sku_key").on(table.datasetVersionId, table.projectId, table.sku),
]);

export const productSuppliers = pgTable("product_suppliers", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	productId: uuid("product_id").notNull(),
	supplierId: uuid("supplier_id").notNull(),
	supplierSku: text("supplier_sku"),
	moq: numeric({ precision: 30, scale:  8 }),
	packMultiple: numeric("pack_multiple", { precision: 30, scale:  8 }),
	conversion: jsonb(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.datasetVersionId],
			foreignColumns: [datasetVersions.projectId, datasetVersions.id],
			name: "product_suppliers_project_id_dataset_version_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.productId],
			foreignColumns: [products.projectId, products.datasetVersionId, products.id],
			name: "product_suppliers_project_id_dataset_version_id_product_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.supplierId],
			foreignColumns: [suppliers.projectId, suppliers.datasetVersionId, suppliers.id],
			name: "product_suppliers_project_id_dataset_version_id_supplier_i_fkey"
		}),
	unique("product_suppliers_project_id_dataset_version_id_product_id__key").on(table.datasetVersionId, table.productId, table.projectId, table.supplierId),
	check("product_suppliers_moq_check", sql`moq >= (0)::numeric`),
	check("product_suppliers_pack_multiple_check", sql`pack_multiple > (0)::numeric`),
]);

export const monthlySales = pgTable("monthly_sales", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	productId: uuid("product_id").notNull(),
	warehouseId: uuid("warehouse_id").notNull(),
	periodMonth: date("period_month").notNull(),
	granularity: text().default('month').notNull(),
	sourceObjectId: uuid("source_object_id").notNull(),
	sourceSheet: text("source_sheet"),
	sourceRowNumber: integer("source_row_number").notNull(),
	quantity: numeric({ precision: 30, scale:  8 }),
	unit: text().notNull(),
	completeness: text().notNull(),
	origin: text().notNull(),
	methodVersion: text("method_version").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.sourceObjectId],
			foreignColumns: [sourceObjects.projectId, sourceObjects.id],
			name: "monthly_sales_project_id_source_object_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.productId],
			foreignColumns: [products.projectId, products.datasetVersionId, products.id],
			name: "monthly_sales_project_id_dataset_version_id_product_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.warehouseId],
			foreignColumns: [warehouses.projectId, warehouses.datasetVersionId, warehouses.id],
			name: "monthly_sales_project_id_dataset_version_id_warehouse_id_fkey"
		}),
	unique("monthly_sales_project_id_dataset_version_id_product_id_ware_key").on(table.datasetVersionId, table.periodMonth, table.productId, table.projectId, table.warehouseId),
	check("monthly_sales_granularity_check", sql`granularity = 'month'::text`),
	check("monthly_sales_source_row_number_check", sql`source_row_number > 0`),
	check("monthly_sales_quantity_check", sql`quantity >= (0)::numeric`),
	check("monthly_sales_completeness_check", sql`completeness = ANY (ARRAY['complete'::text, 'explicit_none'::text, 'missing'::text, 'invalid'::text])`),
	check("monthly_sales_check", sql`((completeness = ANY (ARRAY['complete'::text, 'explicit_none'::text])) AND (quantity IS NOT NULL)) OR ((completeness = ANY (ARRAY['missing'::text, 'invalid'::text])) AND (quantity IS NULL))`),
	check("monthly_sales_origin_check", sql`origin = ANY (ARRAY['partner'::text, 'synthetic'::text, 'mixed'::text])`),
	check("monthly_sales_period_month_check", sql`EXTRACT(day FROM period_month) = (1)::numeric`),
	check("monthly_sales_check1", sql`(completeness <> 'explicit_none'::text) OR (quantity = (0)::numeric)`),
]);

export const seasonalityIndices = pgTable("seasonality_indices", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	productId: uuid("product_id"),
	categoryKey: text("category_key"),
	periodMonth: smallint("period_month").notNull(),
	indexValue: numeric("index_value", { precision: 30, scale:  8 }).notNull(),
	methodVersion: text("method_version").notNull(),
	method: text().notNull(),
	completeness: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.productId],
			foreignColumns: [products.projectId, products.datasetVersionId, products.id],
			name: "seasonality_indices_project_id_dataset_version_id_product__fkey"
		}),
	unique("seasonality_indices_project_id_dataset_version_id_product_i_key").on(table.datasetVersionId, table.methodVersion, table.periodMonth, table.productId, table.projectId),
	check("seasonality_indices_period_month_check", sql`(period_month >= 1) AND (period_month <= 12)`),
	check("seasonality_indices_index_value_check", sql`index_value >= (0)::numeric`),
	check("seasonality_indices_method_check", sql`method = ANY (ARRAY['provided'::text, 'estimated'::text])`),
	check("seasonality_indices_check", sql`(product_id IS NULL) <> (category_key IS NULL)`),
	check("seasonality_indices_completeness_check", sql`completeness = ANY (ARRAY['complete'::text, 'explicit_none'::text, 'missing'::text, 'invalid'::text])`),
]);

export const sales = pgTable("sales", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	productId: uuid("product_id").notNull(),
	warehouseId: uuid("warehouse_id").notNull(),
	soldOn: date("sold_on").notNull(),
	sourceObjectId: uuid("source_object_id").notNull(),
	sourceSheet: text("source_sheet"),
	sourceRowNumber: integer("source_row_number").notNull(),
	quantity: numeric({ precision: 30, scale:  8 }).notNull(),
	unit: text().notNull(),
	operationType: text("operation_type").notNull(),
	sourceEventId: text("source_event_id").notNull(),
	unitPrice: numeric("unit_price", { precision: 30, scale:  8 }),
	anonymousCustomerKey: text("anonymous_customer_key"),
	customerKeyAvailable: boolean("customer_key_available").default(false).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.sourceObjectId],
			foreignColumns: [sourceObjects.projectId, sourceObjects.id],
			name: "sales_project_id_source_object_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.productId],
			foreignColumns: [products.projectId, products.datasetVersionId, products.id],
			name: "sales_project_id_dataset_version_id_product_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.warehouseId],
			foreignColumns: [warehouses.projectId, warehouses.datasetVersionId, warehouses.id],
			name: "sales_project_id_dataset_version_id_warehouse_id_fkey"
		}),
	unique("sales_project_id_dataset_version_id_source_event_id_key").on(table.datasetVersionId, table.projectId, table.sourceEventId),
	check("sales_source_row_number_check", sql`source_row_number > 0`),
	check("sales_operation_type_check", sql`operation_type = ANY (ARRAY['sale'::text, 'return'::text, 'correction'::text])`),
	check("sales_unit_price_check", sql`unit_price >= (0)::numeric`),
	check("sales_check", sql`(customer_key_available AND (anonymous_customer_key IS NOT NULL)) OR ((NOT customer_key_available) AND (anonymous_customer_key IS NULL))`),
	check("sales_check1", sql`(operation_type <> 'sale'::text) OR (quantity >= (0)::numeric)`),
]);

export const stockSnapshots = pgTable("stock_snapshots", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	productId: uuid("product_id").notNull(),
	warehouseId: uuid("warehouse_id").notNull(),
	asOfDate: date("as_of_date").notNull(),
	sourceObjectId: uuid("source_object_id").notNull(),
	sourceSheet: text("source_sheet"),
	sourceRowNumber: integer("source_row_number").notNull(),
	quantity: numeric({ precision: 30, scale:  8 }).notNull(),
	unit: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.sourceObjectId],
			foreignColumns: [sourceObjects.projectId, sourceObjects.id],
			name: "stock_snapshots_project_id_source_object_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.productId],
			foreignColumns: [products.projectId, products.datasetVersionId, products.id],
			name: "stock_snapshots_project_id_dataset_version_id_product_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.warehouseId],
			foreignColumns: [warehouses.projectId, warehouses.datasetVersionId, warehouses.id],
			name: "stock_snapshots_project_id_dataset_version_id_warehouse_id_fkey"
		}),
	unique("stock_snapshots_project_id_dataset_version_id_product_id_wa_key").on(table.asOfDate, table.datasetVersionId, table.productId, table.projectId, table.warehouseId),
	check("stock_snapshots_source_row_number_check", sql`source_row_number > 0`),
	check("stock_snapshots_quantity_check", sql`quantity >= (0)::numeric`),
]);

export const inboundShipments = pgTable("inbound_shipments", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	productId: uuid("product_id").notNull(),
	warehouseId: uuid("warehouse_id").notNull(),
	supplierId: uuid("supplier_id"),
	sourceKey: text("source_key").notNull(),
	expectedOn: date("expected_on").notNull(),
	quantity: numeric({ precision: 30, scale:  8 }).notNull(),
	unit: text().notNull(),
	sourceObjectId: uuid("source_object_id").notNull(),
	sourceSheet: text("source_sheet"),
	sourceRowNumber: integer("source_row_number").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.sourceObjectId],
			foreignColumns: [sourceObjects.projectId, sourceObjects.id],
			name: "inbound_shipments_project_id_source_object_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.productId],
			foreignColumns: [products.projectId, products.datasetVersionId, products.id],
			name: "inbound_shipments_project_id_dataset_version_id_product_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.warehouseId],
			foreignColumns: [warehouses.projectId, warehouses.datasetVersionId, warehouses.id],
			name: "inbound_shipments_project_id_dataset_version_id_warehouse__fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.supplierId],
			foreignColumns: [suppliers.projectId, suppliers.datasetVersionId, suppliers.id],
			name: "inbound_shipments_project_id_dataset_version_id_supplier_i_fkey"
		}),
	unique("inbound_shipments_project_id_dataset_version_id_source_key_key").on(table.datasetVersionId, table.projectId, table.sourceKey),
	check("inbound_shipments_quantity_check", sql`quantity >= (0)::numeric`),
	check("inbound_shipments_source_row_number_check", sql`source_row_number > 0`),
]);

export const stockoutIntervals = pgTable("stockout_intervals", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	productId: uuid("product_id").notNull(),
	warehouseId: uuid("warehouse_id").notNull(),
	startsOn: date("starts_on").notNull(),
	endsOn: date("ends_on").notNull(),
	status: text().notNull(),
	sourceObjectId: uuid("source_object_id").notNull(),
	sourceSheet: text("source_sheet"),
	sourceRowNumber: integer("source_row_number").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.sourceObjectId],
			foreignColumns: [sourceObjects.projectId, sourceObjects.id],
			name: "stockout_intervals_project_id_source_object_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.productId],
			foreignColumns: [products.projectId, products.datasetVersionId, products.id],
			name: "stockout_intervals_project_id_dataset_version_id_product_i_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.warehouseId],
			foreignColumns: [warehouses.projectId, warehouses.datasetVersionId, warehouses.id],
			name: "stockout_intervals_project_id_dataset_version_id_warehouse_fkey"
		}),
	check("stockout_intervals_check", sql`ends_on >= starts_on`),
	check("stockout_intervals_status_check", sql`status = ANY (ARRAY['observed'::text, 'estimated'::text])`),
	check("stockout_intervals_source_row_number_check", sql`source_row_number > 0`),
]);

export const categoryPolicies = pgTable("category_policies", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	categoryKey: text("category_key").notNull(),
	reviewPeriodDays: integer("review_period_days").notNull(),
	safetyStock: numeric("safety_stock", { precision: 30, scale:  8 }),
	parameters: jsonb().default({}).notNull(),
	policyVersion: text("policy_version").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.datasetVersionId],
			foreignColumns: [datasetVersions.projectId, datasetVersions.id],
			name: "category_policies_project_id_dataset_version_id_fkey"
		}),
	unique("category_policies_project_id_dataset_version_id_category_ke_key").on(table.categoryKey, table.datasetVersionId, table.projectId),
	check("category_policies_review_period_days_check", sql`review_period_days > 0`),
	check("category_policies_safety_stock_check", sql`safety_stock >= (0)::numeric`),
]);

export const growthAssumptions = pgTable("growth_assumptions", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	categoryKey: text("category_key").notNull(),
	effectiveFrom: date("effective_from").notNull(),
	growthRate: numeric("growth_rate", { precision: 30, scale:  8 }).notNull(),
	method: text().notNull(),
	provenance: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.datasetVersionId],
			foreignColumns: [datasetVersions.projectId, datasetVersions.id],
			name: "growth_assumptions_project_id_dataset_version_id_fkey"
		}),
	unique("growth_assumptions_project_id_dataset_version_id_category_k_key").on(table.categoryKey, table.datasetVersionId, table.projectId),
	check("growth_assumptions_growth_rate_check", sql`growth_rate >= (0)::numeric`),
	check("growth_assumptions_method_check", sql`method = ANY (ARRAY['provided'::text, 'estimated'::text])`),
]);

export const supplierLeadTimes = pgTable("supplier_lead_times", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	supplierId: uuid("supplier_id").notNull(),
	productId: uuid("product_id"),
	categoryKey: text("category_key"),
	days: integer().notNull(),
	provenance: text().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.productId],
			foreignColumns: [products.projectId, products.datasetVersionId, products.id],
			name: "supplier_lead_times_project_id_dataset_version_id_product__fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.supplierId],
			foreignColumns: [suppliers.projectId, suppliers.datasetVersionId, suppliers.id],
			name: "supplier_lead_times_project_id_dataset_version_id_supplier_fkey"
		}),
	unique("supplier_lead_times_project_id_dataset_version_id_supplier__key").on(table.categoryKey, table.datasetVersionId, table.projectId, table.supplierId),
	check("supplier_lead_times_days_check", sql`days >= 0`),
]);

export const calculationRuns = pgTable("calculation_runs", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	requestedBy: text("requested_by").notNull(),
	scope: jsonb().notNull(),
	asOfDate: date("as_of_date").notNull(),
	configuration: jsonb().notNull(),
	configurationHash: text("configuration_hash").notNull(),
	requestHash: text("request_hash").notNull(),
	algorithmVersion: text("algorithm_version").notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	triggerRunId: text("trigger_run_id"),
	runMode: text("run_mode").notNull(),
	status: text().notNull(),
	stage: text(),
	stageStates: jsonb("stage_states").default({}).notNull(),
	explanationStatus: text("explanation_status").default('not_requested').notNull(),
	warnings: jsonb("warnings").default([]).notNull(),
	resultVersion: integer("result_version"),
	coverageGate: text("coverage_gate").default('incomplete').notNull(),
	blockingReasons: jsonb("blocking_reasons").default([]).notNull(),
	safeError: text("safe_error"),
	stateVersion: integer("state_version").default(0).notNull(),
	reviewVersion: integer("review_version").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.datasetVersionId],
			foreignColumns: [datasetVersions.projectId, datasetVersions.id],
			name: "calculation_runs_project_id_dataset_version_id_fkey"
		}),
	unique("calculation_runs_project_id_id_key").on(table.id, table.projectId),
	unique("calculation_runs_project_id_dataset_version_id_id_key").on(table.datasetVersionId, table.id, table.projectId),
	unique("calculation_runs_project_id_idempotency_key_key").on(table.idempotencyKey, table.projectId),
	check("calculation_runs_configuration_hash_check", sql`configuration_hash ~ '^[a-f0-9]{64}$'::text`),
	check("calculation_runs_request_hash_check", sql`request_hash ~ '^[a-f0-9]{64}$'::text`),
	check("calculation_runs_run_mode_check", sql`run_mode = ANY (ARRAY['full'::text, 'diagnostic'::text])`),
	check("calculation_runs_status_check", sql`status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])`),
	check("calculation_runs_stage_check", sql`stage = ANY (ARRAY['validate'::text, 'forecast'::text, 'recommend'::text, 'explain'::text])`),
	check("calculation_runs_explanation_status_check", sql`explanation_status = ANY (ARRAY['not_requested'::text, 'pending'::text, 'succeeded'::text, 'degraded'::text])`),
	check("calculation_runs_coverage_gate_check", sql`coverage_gate = ANY (ARRAY['complete'::text, 'incomplete'::text])`),
	check("calculation_runs_state_version_check", sql`state_version >= 0`),
	check("calculation_runs_review_version_check", sql`review_version >= 0`),
	check("calculation_runs_warnings_check", sql`jsonb_typeof(warnings) = 'array'`),
	check("calculation_runs_result_version_check", sql`result_version IS NULL OR (result_version > 0 AND status = 'succeeded')`),
]);

export const dispatchIntents = pgTable("dispatch_intents", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	operationType: text("operation_type").notNull(),
	importId: uuid("import_id"),
	runId: uuid("run_id"),
	idempotencyKey: text("idempotency_key").notNull(),
	payloadVersion: text("payload_version").notNull(),
	payloadHash: text("payload_hash").notNull(),
	status: text().default('pending').notNull(),
	attempts: integer().default(0).notNull(),
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: 'string' }),
	leaseUntil: timestamp("lease_until", { withTimezone: true, mode: 'string' }),
	externalTaskId: text("external_task_id"),
	cancelAttempts: integer("cancel_attempts").default(0).notNull(),
	cancelAckAt: timestamp("cancel_ack_at", { withTimezone: true, mode: 'string' }),
	safeError: text("safe_error"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.importId],
			foreignColumns: [imports.projectId, imports.id],
			name: "dispatch_intents_project_id_import_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.runId],
			foreignColumns: [calculationRuns.projectId, calculationRuns.id],
			name: "dispatch_intents_project_id_run_id_fkey"
		}),
	unique("dispatch_intents_project_id_idempotency_key_key").on(table.idempotencyKey, table.projectId, table.operationType),
	unique("dispatch_intents_import_id_key").on(table.importId),
	unique("dispatch_intents_run_id_key").on(table.runId),
	check("dispatch_intents_operation_type_check", sql`operation_type = ANY (ARRAY['import'::text, 'calculation'::text])`),
	check("dispatch_intents_payload_hash_check", sql`payload_hash ~ '^[a-f0-9]{64}$'::text`),
	check("dispatch_intents_status_check", sql`status = ANY (ARRAY['pending'::text, 'leased'::text, 'sent'::text, 'failed'::text])`),
	check("dispatch_intents_attempts_check", sql`attempts >= 0`),
	check("dispatch_intents_cancel_attempts_check", sql`cancel_attempts >= 0`),
	check("dispatch_intents_check", sql`((operation_type = 'import'::text) AND (import_id IS NOT NULL) AND (run_id IS NULL)) OR ((operation_type = 'calculation'::text) AND (run_id IS NOT NULL) AND (import_id IS NULL))`),
]);

export const recommendations = pgTable("recommendations", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	datasetVersionId: uuid("dataset_version_id").notNull(),
	runId: uuid("run_id").notNull(),
	productId: uuid("product_id").notNull(),
	warehouseId: uuid("warehouse_id").notNull(),
	supplierId: uuid("supplier_id").notNull(),
	calculationVersion: text("calculation_version").notNull(),
	supplierArticle: text("supplier_article"),
	projectedStockoutDate: date("projected_stockout_date"),
	shortageDays: integer("shortage_days"),
	recommendedQuantity: numeric("recommended_quantity", { precision: 30, scale:  8 }),
	quantityStatus: text("quantity_status").notNull(),
	unit: text().notNull(),
	urgency: text().notNull(),
	numericFactors: jsonb("numeric_factors").notNull(),
	evidence: jsonb("evidence"),
	warnings: jsonb("warnings").default([]).notNull(),
	dataQuality: text("data_quality").notNull(),
	rationale: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.runId],
			foreignColumns: [calculationRuns.projectId, calculationRuns.datasetVersionId, calculationRuns.id],
			name: "recommendations_project_id_dataset_version_id_run_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.productId],
			foreignColumns: [products.projectId, products.datasetVersionId, products.id],
			name: "recommendations_project_id_dataset_version_id_product_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.warehouseId],
			foreignColumns: [warehouses.projectId, warehouses.datasetVersionId, warehouses.id],
			name: "recommendations_project_id_dataset_version_id_warehouse_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.supplierId],
			foreignColumns: [suppliers.projectId, suppliers.datasetVersionId, suppliers.id],
			name: "recommendations_project_id_dataset_version_id_supplier_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.datasetVersionId, table.productId, table.supplierId],
			foreignColumns: [productSuppliers.projectId, productSuppliers.datasetVersionId, productSuppliers.productId, productSuppliers.supplierId],
			name: "recommendations_project_id_dataset_version_id_product_id_s_fkey"
		}),
	unique("recommendations_project_id_run_id_id_key").on(table.id, table.projectId, table.runId),
	unique("recommendations_run_id_product_id_warehouse_id_supplier_id_key").on(table.productId, table.runId, table.supplierId, table.warehouseId),
	check("recommendations_shortage_days_check", sql`shortage_days >= 0`),
	check("recommendations_recommended_quantity_check", sql`recommended_quantity >= (0)::numeric`),
	check("recommendations_quantity_status_check", sql`quantity_status = ANY (ARRAY['known'::text, 'unavailable'::text])`),
	check("recommendations_urgency_check", sql`urgency = ANY (ARRAY['unknown'::text, 'urgent'::text, 'planned'::text, 'none'::text])`),
	check("recommendations_data_quality_check", sql`data_quality IN ('complete','limited','unavailable')`),
	check("recommendations_check", sql`((quantity_status = 'known'::text) AND (recommended_quantity IS NOT NULL) AND (data_quality <> 'unavailable'::text) AND (urgency <> 'unknown'::text)) OR ((quantity_status = 'unavailable'::text) AND (recommended_quantity IS NULL) AND (data_quality = 'unavailable'::text))`),
	check("recommendations_numeric_factors_check", sql`jsonb_typeof(numeric_factors) = 'array'::text`),
	check("recommendations_warnings_check", sql`jsonb_typeof(warnings) = 'array'`),
]);

export const recommendationReviews = pgTable("recommendation_reviews", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	runId: uuid("run_id").notNull(),
	recommendationId: uuid("recommendation_id").notNull(),
	reviewVersion: integer("review_version").notNull(),
	reviewedQuantity: numeric("reviewed_quantity", { precision: 30, scale:  8 }).notNull(),
	reason: text().notNull(),
	authorUserId: text("author_user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.runId],
			foreignColumns: [calculationRuns.projectId, calculationRuns.id],
			name: "recommendation_reviews_project_id_run_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.runId, table.recommendationId],
			foreignColumns: [recommendations.projectId, recommendations.runId, recommendations.id],
			name: "recommendation_reviews_project_id_run_id_recommendation_id_fkey"
		}),
	unique("recommendation_reviews_recommendation_id_review_version_key").on(table.recommendationId, table.reviewVersion),
	check("recommendation_reviews_review_version_check", sql`review_version > 0`),
	check("recommendation_reviews_reviewed_quantity_check", sql`reviewed_quantity >= (0)::numeric`),
	check("recommendation_reviews_reason_check", sql`length(TRIM(BOTH FROM reason)) > 0`),
]);

export const approvals = pgTable("approvals", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	runId: uuid("run_id").notNull(),
	reviewVersion: integer("review_version").notNull(),
	linesHash: text("lines_hash").notNull(),
	authorUserId: text("author_user_id").notNull(),
	idempotencyKey: text("idempotency_key").notNull(),
	requestHash: text("request_hash").notNull(),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.runId],
			foreignColumns: [calculationRuns.projectId, calculationRuns.id],
			name: "approvals_project_id_run_id_fkey"
		}),
	unique("approvals_project_id_id_key").on(table.id, table.projectId),
	unique("approvals_run_id_review_version_key").on(table.reviewVersion, table.runId),
	unique("approvals_run_id_idempotency_key_key").on(table.idempotencyKey, table.runId),
	check("approvals_review_version_check", sql`review_version >= 0`),
	check("approvals_lines_hash_check", sql`lines_hash ~ '^[a-f0-9]{64}$'::text`),
	check("approvals_request_hash_check", sql`request_hash ~ '^[a-f0-9]{64}$'::text`),
]);

export const exportArtifacts = pgTable("export_artifacts", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	approvalId: uuid("approval_id").notNull(),
	sourceObjectId: uuid("source_object_id").notNull(),
	checksum: text().notNull(),
	format: text().notNull(),
	formatVersion: text("format_version").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.approvalId],
			foreignColumns: [approvals.projectId, approvals.id],
			name: "export_artifacts_project_id_approval_id_fkey"
		}),
	foreignKey({
			columns: [table.projectId, table.sourceObjectId, table.checksum],
			foreignColumns: [sourceObjects.projectId, sourceObjects.id, sourceObjects.checksum],
			name: "export_artifacts_project_id_source_object_id_checksum_fkey"
		}),
	unique("export_artifacts_approval_id_format_version_key").on(table.approvalId, table.formatVersion),
	check("export_artifacts_checksum_check", sql`checksum ~ '^[a-f0-9]{64}$'::text`),
]);

export const runEvents = pgTable("run_events", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	runId: uuid("run_id").notNull(),
	sequenceNo: integer("sequence_no").notNull(),
	eventType: text("event_type").notNull(),
	safePayload: jsonb("safe_payload").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId, table.runId],
			foreignColumns: [calculationRuns.projectId, calculationRuns.id],
			name: "run_events_project_id_run_id_fkey"
		}),
	unique("run_events_run_id_sequence_no_key").on(table.runId, table.sequenceNo),
	check("run_events_sequence_no_check", sql`sequence_no > 0`),
]);

export const auditEvents = pgTable("audit_events", {
	id: uuid().primaryKey().notNull(),
	projectId: uuid("project_id").notNull(),
	sequenceNo: integer("sequence_no").notNull(),
	actorUserId: text("actor_user_id").notNull(),
	action: text().notNull(),
	resourceType: text("resource_type").notNull(),
	resourceId: uuid("resource_id").notNull(),
	safePayload: jsonb("safe_payload").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.projectId],
			foreignColumns: [projects.id],
			name: "audit_events_project_id_fkey"
		}),
	unique("audit_events_project_id_sequence_no_key").on(table.projectId, table.sequenceNo),
	check("audit_events_sequence_no_check", sql`sequence_no > 0`),
]);
