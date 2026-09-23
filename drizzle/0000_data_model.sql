-- Feature 04: project-scoped, immutable procurement input and result snapshots.
CREATE TABLE projects (
  id uuid PRIMARY KEY, owner_user_id text NOT NULL CHECK (length(owner_user_id)>0),
  name text NOT NULL CHECK (length(trim(name))>0), created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  UNIQUE (id, owner_user_id)
);
CREATE TABLE source_objects (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id),
  object_key text NOT NULL UNIQUE, checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 26214400), content_type text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('source','report','export')),
  CHECK (object_key = 'projects/' || project_id::text || '/' || purpose || 's/' || id::text),
  CHECK ((purpose='source' AND content_type IN ('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','application/zip')) OR
    (purpose='report' AND content_type IN ('application/json','text/csv')) OR (purpose='export' AND content_type='text/csv')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,id), UNIQUE(project_id,id,checksum), UNIQUE(project_id,checksum)
);
CREATE TABLE imports (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id),
  source_object_id uuid NOT NULL, checksum text NOT NULL, manifest jsonb NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  adapter_version text NOT NULL, schema_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('uploaded','awaiting-validation','validating','needs_mapping','invalid','ready','failed')),
  quality_report jsonb, safe_error text, state_version integer NOT NULL DEFAULT 0 CHECK(state_version>=0),
  dataset_version_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,source_object_id,checksum) REFERENCES source_objects(project_id,id,checksum),
  UNIQUE(project_id,id), UNIQUE(project_id,checksum,manifest_hash,adapter_version,schema_version)
);
CREATE TABLE dataset_versions (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), import_id uuid NOT NULL,
  manifest jsonb NOT NULL, manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  as_of_date date NOT NULL, provenance text NOT NULL CHECK (provenance IN ('partner','synthetic','mixed')),
  source_completeness jsonb NOT NULL, schema_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,import_id) REFERENCES imports(project_id,id), UNIQUE(project_id,id), UNIQUE(project_id,import_id,id)
);
ALTER TABLE imports ADD CONSTRAINT imports_dataset_fk FOREIGN KEY(project_id,id,dataset_version_id) REFERENCES dataset_versions(project_id,import_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE suppliers (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  source_key text NOT NULL, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,dataset_version_id) REFERENCES dataset_versions(project_id,id),
  UNIQUE(project_id,dataset_version_id,id), UNIQUE(project_id,dataset_version_id,source_key)
);
CREATE TABLE warehouses (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  source_key text NOT NULL, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,dataset_version_id) REFERENCES dataset_versions(project_id,id),
  UNIQUE(project_id,dataset_version_id,id), UNIQUE(project_id,dataset_version_id,source_key)
);
CREATE TABLE products (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  source_key text NOT NULL, sku text NOT NULL, name text NOT NULL, unit text NOT NULL, category_key text NOT NULL,
  conversions jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,dataset_version_id) REFERENCES dataset_versions(project_id,id),
  UNIQUE(project_id,dataset_version_id,id), UNIQUE(project_id,dataset_version_id,source_key),
  UNIQUE(project_id,dataset_version_id,sku)
);
CREATE TABLE product_suppliers (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  product_id uuid NOT NULL, supplier_id uuid NOT NULL, supplier_sku text,
  moq numeric(30,8) CHECK(moq>=0), pack_multiple numeric(30,8) CHECK(pack_multiple>0),
  conversion jsonb,
  FOREIGN KEY(project_id,dataset_version_id) REFERENCES dataset_versions(project_id,id),
  FOREIGN KEY(project_id,dataset_version_id,product_id) REFERENCES products(project_id,dataset_version_id,id),
  FOREIGN KEY(project_id,dataset_version_id,supplier_id) REFERENCES suppliers(project_id,dataset_version_id,id),
  UNIQUE(project_id,dataset_version_id,product_id,supplier_id)
);
CREATE TABLE monthly_sales (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  product_id uuid NOT NULL, warehouse_id uuid NOT NULL, period_month date NOT NULL, granularity text NOT NULL DEFAULT 'month' CHECK(granularity='month'),
  source_object_id uuid NOT NULL, source_sheet text, source_row_number integer NOT NULL CHECK(source_row_number>0),
  quantity numeric(30,8) CHECK(quantity>=0), unit text NOT NULL,
  completeness text NOT NULL CHECK(completeness IN ('complete','explicit_none','missing','invalid')),
  CHECK ((completeness IN ('complete','explicit_none') AND quantity IS NOT NULL) OR (completeness IN ('missing','invalid') AND quantity IS NULL)),
  origin text NOT NULL CHECK(origin IN ('partner','synthetic','mixed')), method_version text NOT NULL,
  CHECK(EXTRACT(day FROM period_month)=1),
  CHECK(completeness <> 'explicit_none' OR quantity=0),
  FOREIGN KEY(project_id,source_object_id) REFERENCES source_objects(project_id,id),
  FOREIGN KEY(project_id,dataset_version_id,product_id) REFERENCES products(project_id,dataset_version_id,id),
  FOREIGN KEY(project_id,dataset_version_id,warehouse_id) REFERENCES warehouses(project_id,dataset_version_id,id),
  UNIQUE(project_id,dataset_version_id,product_id,warehouse_id,period_month)
);
CREATE TABLE seasonality_indices (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  product_id uuid, category_key text, period_month smallint NOT NULL CHECK(period_month BETWEEN 1 AND 12),
  index_value numeric(30,8) NOT NULL CHECK(index_value>=0), method_version text NOT NULL,
  method text NOT NULL CHECK(method IN ('provided','estimated')),
  CHECK((product_id IS NULL) <> (category_key IS NULL)),
  completeness text NOT NULL CHECK(completeness IN ('complete','explicit_none','missing','invalid')),
  FOREIGN KEY(project_id,dataset_version_id,product_id) REFERENCES products(project_id,dataset_version_id,id),
  UNIQUE(project_id,dataset_version_id,product_id,period_month,method_version)
);
CREATE TABLE sales (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  product_id uuid NOT NULL, warehouse_id uuid NOT NULL, sold_on date NOT NULL,
  source_object_id uuid NOT NULL, source_sheet text, source_row_number integer NOT NULL CHECK(source_row_number>0),
  quantity numeric(30,8) NOT NULL, unit text NOT NULL, operation_type text NOT NULL CHECK(operation_type IN ('sale','return','correction')),
  source_event_id text NOT NULL, unit_price numeric(30,8) CHECK(unit_price>=0),
  anonymous_customer_key text, customer_key_available boolean NOT NULL DEFAULT false,
  CHECK ((customer_key_available AND anonymous_customer_key IS NOT NULL) OR (NOT customer_key_available AND anonymous_customer_key IS NULL)),
  CHECK(operation_type <> 'sale' OR quantity>=0),
  FOREIGN KEY(project_id,source_object_id) REFERENCES source_objects(project_id,id),
  FOREIGN KEY(project_id,dataset_version_id,product_id) REFERENCES products(project_id,dataset_version_id,id),
  FOREIGN KEY(project_id,dataset_version_id,warehouse_id) REFERENCES warehouses(project_id,dataset_version_id,id),
  UNIQUE(project_id,dataset_version_id,source_event_id)
);
CREATE TABLE stock_snapshots (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  product_id uuid NOT NULL, warehouse_id uuid NOT NULL, as_of_date date NOT NULL,
  source_object_id uuid NOT NULL, source_sheet text, source_row_number integer NOT NULL CHECK(source_row_number>0),
  quantity numeric(30,8) NOT NULL CHECK(quantity>=0), unit text NOT NULL,
  FOREIGN KEY(project_id,source_object_id) REFERENCES source_objects(project_id,id),
  FOREIGN KEY(project_id,dataset_version_id,product_id) REFERENCES products(project_id,dataset_version_id,id),
  FOREIGN KEY(project_id,dataset_version_id,warehouse_id) REFERENCES warehouses(project_id,dataset_version_id,id),
  UNIQUE(project_id,dataset_version_id,product_id,warehouse_id,as_of_date)
);
CREATE TABLE inbound_shipments (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  product_id uuid NOT NULL, warehouse_id uuid NOT NULL, supplier_id uuid,
  source_key text NOT NULL, expected_on date NOT NULL, quantity numeric(30,8) NOT NULL CHECK(quantity>=0), unit text NOT NULL,
  source_object_id uuid NOT NULL, source_sheet text, source_row_number integer NOT NULL CHECK(source_row_number>0),
  FOREIGN KEY(project_id,source_object_id) REFERENCES source_objects(project_id,id),
  FOREIGN KEY(project_id,dataset_version_id,product_id) REFERENCES products(project_id,dataset_version_id,id),
  FOREIGN KEY(project_id,dataset_version_id,warehouse_id) REFERENCES warehouses(project_id,dataset_version_id,id),
  FOREIGN KEY(project_id,dataset_version_id,supplier_id) REFERENCES suppliers(project_id,dataset_version_id,id),
  UNIQUE(project_id,dataset_version_id,source_key)
);
CREATE TABLE stockout_intervals (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  product_id uuid NOT NULL, warehouse_id uuid NOT NULL,
  starts_on date NOT NULL, ends_on date NOT NULL CHECK(ends_on>=starts_on), status text NOT NULL CHECK(status IN ('observed','estimated')),
  source_object_id uuid NOT NULL, source_sheet text, source_row_number integer NOT NULL CHECK(source_row_number>0),
  FOREIGN KEY(project_id,source_object_id) REFERENCES source_objects(project_id,id),
  FOREIGN KEY(project_id,dataset_version_id,product_id) REFERENCES products(project_id,dataset_version_id,id),
  FOREIGN KEY(project_id,dataset_version_id,warehouse_id) REFERENCES warehouses(project_id,dataset_version_id,id)
);
CREATE TABLE category_policies (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  category_key text NOT NULL, review_period_days integer NOT NULL CHECK(review_period_days>0),
  safety_stock numeric(30,8) CHECK(safety_stock>=0), parameters jsonb NOT NULL DEFAULT '{}'::jsonb, policy_version text NOT NULL,
  FOREIGN KEY(project_id,dataset_version_id) REFERENCES dataset_versions(project_id,id),
  UNIQUE(project_id,dataset_version_id,category_key)
);
CREATE TABLE growth_assumptions (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  category_key text NOT NULL, effective_from date NOT NULL, growth_rate numeric(30,8) NOT NULL CHECK(growth_rate>=0),
  method text NOT NULL CHECK(method IN ('provided','estimated')), provenance text NOT NULL,
  FOREIGN KEY(project_id,dataset_version_id) REFERENCES dataset_versions(project_id,id),
  UNIQUE(project_id,dataset_version_id,category_key)
);
CREATE TABLE supplier_lead_times (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  supplier_id uuid NOT NULL, product_id uuid, category_key text, days integer NOT NULL CHECK(days>=0),
  provenance text NOT NULL,
  FOREIGN KEY(project_id,dataset_version_id,product_id) REFERENCES products(project_id,dataset_version_id,id),
  FOREIGN KEY(project_id,dataset_version_id,supplier_id) REFERENCES suppliers(project_id,dataset_version_id,id),
  UNIQUE(project_id,dataset_version_id,supplier_id,category_key)
);
CREATE TABLE calculation_runs (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL,
  requested_by text NOT NULL, scope jsonb NOT NULL, as_of_date date NOT NULL,
  configuration jsonb NOT NULL, configuration_hash text NOT NULL CHECK(configuration_hash ~ '^[a-f0-9]{64}$'),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), algorithm_version text NOT NULL,
  idempotency_key text NOT NULL, trigger_run_id text,
  run_mode text NOT NULL CHECK(run_mode IN ('full','diagnostic')),
  status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  stage text CHECK(stage IN ('validate','forecast','recommend','explain')),
  stage_states jsonb NOT NULL DEFAULT '{}'::jsonb, explanation_status text NOT NULL DEFAULT 'not_requested'
    CHECK(explanation_status IN ('not_requested','pending','succeeded','degraded')),
  coverage_gate text NOT NULL DEFAULT 'incomplete' CHECK(coverage_gate IN ('complete','incomplete')),
  blocking_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  safe_error text, state_version integer NOT NULL DEFAULT 0 CHECK(state_version>=0),
  review_version integer NOT NULL DEFAULT 0 CHECK(review_version>=0),
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  FOREIGN KEY(project_id,dataset_version_id) REFERENCES dataset_versions(project_id,id),
  UNIQUE(project_id,id), UNIQUE(project_id,dataset_version_id,id), UNIQUE(project_id,idempotency_key)
);
CREATE TABLE dispatch_intents (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, operation_type text NOT NULL CHECK(operation_type IN ('import','calculation')),
  import_id uuid, run_id uuid, idempotency_key text NOT NULL, payload_version text NOT NULL,
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','sent','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_at timestamptz,
  lease_until timestamptz, external_task_id text, safe_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((operation_type='import' AND import_id IS NOT NULL AND run_id IS NULL) OR
         (operation_type='calculation' AND run_id IS NOT NULL AND import_id IS NULL)),
  FOREIGN KEY(project_id,import_id) REFERENCES imports(project_id,id),
  FOREIGN KEY(project_id,run_id) REFERENCES calculation_runs(project_id,id),
  CONSTRAINT dispatch_intents_project_id_idempotency_key_key UNIQUE(project_id,operation_type,idempotency_key), UNIQUE(import_id), UNIQUE(run_id)
);
CREATE TABLE recommendations (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, dataset_version_id uuid NOT NULL, run_id uuid NOT NULL,
  product_id uuid NOT NULL, warehouse_id uuid NOT NULL, supplier_id uuid NOT NULL,
  calculation_version text NOT NULL, supplier_article text, projected_stockout_date date,
  shortage_days integer CHECK(shortage_days>=0),
  recommended_quantity numeric(30,8) CHECK(recommended_quantity>=0),
  quantity_status text NOT NULL CHECK(quantity_status IN ('known','unavailable')),
  unit text NOT NULL, urgency text NOT NULL CHECK(urgency IN ('unknown','urgent','planned','none')), numeric_factors jsonb NOT NULL,
  data_quality text NOT NULL CHECK(data_quality IN ('complete','limited','unavailable')), rationale text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((quantity_status='known' AND recommended_quantity IS NOT NULL AND data_quality<>'unavailable' AND urgency<>'unknown') OR
         (quantity_status='unavailable' AND recommended_quantity IS NULL AND data_quality='unavailable')),
  CHECK(jsonb_typeof(numeric_factors)='array'),
  FOREIGN KEY(project_id,dataset_version_id,run_id) REFERENCES calculation_runs(project_id,dataset_version_id,id),
  FOREIGN KEY(project_id,dataset_version_id,product_id) REFERENCES products(project_id,dataset_version_id,id),
  FOREIGN KEY(project_id,dataset_version_id,warehouse_id) REFERENCES warehouses(project_id,dataset_version_id,id),
  FOREIGN KEY(project_id,dataset_version_id,supplier_id) REFERENCES suppliers(project_id,dataset_version_id,id),
  FOREIGN KEY(project_id,dataset_version_id,product_id,supplier_id) REFERENCES product_suppliers(project_id,dataset_version_id,product_id,supplier_id),
  UNIQUE(project_id,run_id,id), UNIQUE(run_id,product_id,warehouse_id,supplier_id)
);
CREATE TABLE recommendation_reviews (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, recommendation_id uuid NOT NULL,
  review_version integer NOT NULL CHECK(review_version>0), reviewed_quantity numeric(30,8) NOT NULL CHECK(reviewed_quantity>=0),
  reason text NOT NULL CHECK(length(trim(reason))>0), author_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,run_id) REFERENCES calculation_runs(project_id,id),
  FOREIGN KEY(project_id,run_id,recommendation_id) REFERENCES recommendations(project_id,run_id,id),
  UNIQUE(recommendation_id,review_version)
);
CREATE TABLE approvals (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, review_version integer NOT NULL CHECK(review_version>=0),
  lines_hash text NOT NULL CHECK(lines_hash ~ '^[a-f0-9]{64}$'), author_user_id text NOT NULL,
  idempotency_key text NOT NULL, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,run_id) REFERENCES calculation_runs(project_id,id),
  UNIQUE(project_id,id), UNIQUE(run_id,review_version), UNIQUE(run_id,idempotency_key)
);
CREATE TABLE export_artifacts (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, approval_id uuid NOT NULL, source_object_id uuid NOT NULL,
  checksum text NOT NULL CHECK(checksum ~ '^[a-f0-9]{64}$'), format text NOT NULL, format_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,approval_id) REFERENCES approvals(project_id,id),
  FOREIGN KEY(project_id,source_object_id,checksum) REFERENCES source_objects(project_id,id,checksum),
  UNIQUE(approval_id,format_version)
);
CREATE TABLE run_events (
  id uuid PRIMARY KEY, project_id uuid NOT NULL, run_id uuid NOT NULL, sequence_no integer NOT NULL CHECK(sequence_no>0),
  event_type text NOT NULL, safe_payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,run_id) REFERENCES calculation_runs(project_id,id), UNIQUE(run_id,sequence_no)
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), sequence_no integer NOT NULL CHECK(sequence_no>0),
  actor_user_id text NOT NULL, action text NOT NULL, resource_type text NOT NULL, resource_id uuid NOT NULL,
  safe_payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,sequence_no)
);
-- Published input/result rows never change. Reviews and approvals are appended separately.
CREATE FUNCTION reject_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable snapshot'; END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['source_objects','dataset_versions','suppliers','warehouses','products','product_suppliers',
    'monthly_sales','seasonality_indices','sales','stock_snapshots','inbound_shipments','stockout_intervals',
    'category_policies','growth_assumptions','supplier_lead_times','recommendations','recommendation_reviews',
    'approvals','export_artifacts','run_events','audit_events'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_row BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_snapshot_mutation()',t);
  END LOOP;
END $$;
-- All project-bound writes (including dispatch status) stop after archival.
CREATE FUNCTION reject_archived_project_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid; BEGIN
  pid := CASE WHEN TG_OP='DELETE' THEN OLD.project_id ELSE NEW.project_id END;
  IF EXISTS (SELECT 1 FROM projects WHERE id=pid AND archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'project archived';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['source_objects','imports','dataset_versions','suppliers','warehouses','products','product_suppliers',
    'monthly_sales','seasonality_indices','sales','stock_snapshots','inbound_shipments','stockout_intervals',
    'category_policies','growth_assumptions','supplier_lead_times','calculation_runs','dispatch_intents',
    'recommendations','recommendation_reviews','approvals','export_artifacts','run_events','audit_events'] LOOP
    EXECUTE format('CREATE TRIGGER archived_project_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_archived_project_write()',t);
  END LOOP;
END $$;

-- Mutable orchestration rows retain their immutable request identity and monotonic versions.
CREATE FUNCTION guard_import_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.project_id,NEW.source_object_id,NEW.checksum,NEW.manifest,NEW.manifest_hash,NEW.adapter_version,NEW.schema_version,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.project_id,OLD.source_object_id,OLD.checksum,OLD.manifest,OLD.manifest_hash,OLD.adapter_version,OLD.schema_version,OLD.created_at)
     OR NEW.state_version <> OLD.state_version+1
     OR (OLD.dataset_version_id IS NOT NULL AND (NEW.dataset_version_id IS DISTINCT FROM OLD.dataset_version_id OR NEW.status <> 'ready')) THEN
    RAISE EXCEPTION 'immutable import identity or stale state version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_update_guard BEFORE UPDATE ON imports FOR EACH ROW EXECUTE FUNCTION guard_import_update();
CREATE FUNCTION guard_run_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.project_id,NEW.dataset_version_id,NEW.requested_by,NEW.scope,NEW.as_of_date,NEW.configuration,NEW.configuration_hash,
         NEW.request_hash,NEW.algorithm_version,NEW.idempotency_key,NEW.run_mode,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.project_id,OLD.dataset_version_id,OLD.requested_by,OLD.scope,OLD.as_of_date,OLD.configuration,OLD.configuration_hash,
         OLD.request_hash,OLD.algorithm_version,OLD.idempotency_key,OLD.run_mode,OLD.created_at)
     OR NEW.state_version <> OLD.state_version+1 OR NEW.review_version < OLD.review_version
     OR (OLD.status IN ('succeeded','failed','cancelled') AND NEW.status <> OLD.status) THEN
    RAISE EXCEPTION 'immutable run identity or stale state version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER run_update_guard BEFORE UPDATE ON calculation_runs FOR EACH ROW EXECUTE FUNCTION guard_run_update();
CREATE FUNCTION guard_dispatch_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.project_id,NEW.operation_type,NEW.import_id,NEW.run_id,NEW.idempotency_key,NEW.payload_version,NEW.payload_hash,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.project_id,OLD.operation_type,OLD.import_id,OLD.run_id,OLD.idempotency_key,OLD.payload_version,OLD.payload_hash,OLD.created_at) THEN
    RAISE EXCEPTION 'immutable dispatch identity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dispatch_update_guard BEFORE UPDATE ON dispatch_intents FOR EACH ROW EXECUTE FUNCTION guard_dispatch_update();
CREATE FUNCTION guard_project_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL THEN RAISE EXCEPTION 'project archived'; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.owner_user_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.owner_user_id,OLD.created_at) THEN
    RAISE EXCEPTION 'project identity is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_update_guard BEFORE UPDATE OR DELETE ON projects FOR EACH ROW EXECUTE FUNCTION guard_project_update();
CREATE FUNCTION guard_recommendation_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM calculation_runs WHERE id=NEW.run_id AND project_id=NEW.project_id
    AND dataset_version_id=NEW.dataset_version_id AND status IN ('queued','running')
    AND (NEW.quantity_status='known' OR run_mode='diagnostic')) THEN
    RAISE EXCEPTION 'recommendation cannot be added to terminal/full run';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER recommendation_mode_guard BEFORE INSERT ON recommendations FOR EACH ROW EXECUTE FUNCTION guard_recommendation_mode();
CREATE FUNCTION guard_approval_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM calculation_runs r WHERE r.id=NEW.run_id AND r.project_id=NEW.project_id
    AND r.run_mode='full' AND r.status='succeeded' AND r.coverage_gate='complete'
    AND r.blocking_reasons='[]'::jsonb AND r.safe_error IS NULL AND r.review_version=NEW.review_version)
    OR NOT EXISTS (SELECT 1 FROM recommendations WHERE run_id=NEW.run_id)
    OR EXISTS (SELECT 1 FROM recommendations WHERE run_id=NEW.run_id AND recommended_quantity IS NULL) THEN
    RAISE EXCEPTION 'run is not approvable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approval_state_guard BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION guard_approval_state();

-- Publication freezes membership. Normalized rows are inserted in the publication transaction.
CREATE FUNCTION guard_dataset_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM dataset_versions WHERE id=NEW.dataset_version_id AND project_id=NEW.project_id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM imports WHERE dataset_version_id=NEW.dataset_version_id AND project_id=NEW.project_id AND status='ready')
     OR EXISTS (SELECT 1 FROM calculation_runs WHERE dataset_version_id=NEW.dataset_version_id AND project_id=NEW.project_id) THEN
    RAISE EXCEPTION 'dataset already published or used by a calculation';
  END IF;
  RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers','warehouses','products','product_suppliers','monthly_sales','seasonality_indices',
    'sales','stock_snapshots','inbound_shipments','stockout_intervals','category_policies','growth_assumptions','supplier_lead_times'] LOOP
    EXECUTE format('CREATE TRIGGER dataset_membership_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guard_dataset_membership()',t);
  END LOOP;
END $$;
CREATE FUNCTION guard_full_run_sources() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE completeness jsonb; BEGIN
  SELECT source_completeness INTO completeness FROM dataset_versions
    WHERE id=NEW.dataset_version_id AND project_id=NEW.project_id FOR UPDATE;
  IF NEW.run_mode='full' THEN
    IF jsonb_typeof(completeness)<>'array' OR jsonb_array_length(completeness)<>12 THEN
      RAISE EXCEPTION 'full run requires declared source completeness';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(completeness) AS item
      WHERE item->>'sourceType' IN ('sales','stock','inbound','stockouts','suppliers','categories','growth','product_mapping','lead_times')
        AND item->>'status' NOT IN ('complete','explicit_none')) OR
      (NEW.configuration->>'seasonalityMode'='provided' AND EXISTS
        (SELECT 1 FROM jsonb_array_elements(completeness) AS item WHERE item->>'sourceType'='seasonality'
          AND item->>'status' NOT IN ('complete','explicit_none'))) THEN
      RAISE EXCEPTION 'full run requires complete mandatory sources';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER full_run_sources_guard BEFORE INSERT ON calculation_runs FOR EACH ROW EXECUTE FUNCTION guard_full_run_sources();

CREATE FUNCTION guard_dataset_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM imports i WHERE i.id=NEW.import_id AND i.project_id=NEW.project_id
    AND i.status='validating' AND i.dataset_version_id IS NULL AND i.quality_report IS NOT NULL
    AND i.manifest=NEW.manifest AND i.manifest_hash=NEW.manifest_hash
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(i.quality_report->'issues','[]'::jsonb)) AS issue
      WHERE issue->>'severity'='blocking')) THEN
    RAISE EXCEPTION 'import is not validated for publication';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER dataset_publication_guard BEFORE INSERT ON dataset_versions FOR EACH ROW EXECUTE FUNCTION guard_dataset_publication();
