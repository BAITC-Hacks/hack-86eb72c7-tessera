-- Метаданные09/09a дополняют опубликованные снимки, не меняя исходные данные.
ALTER TABLE imports
  ADD COLUMN report_object_id uuid,
  ADD COLUMN report_checksum text,
  ADD COLUMN publication_manifest jsonb,
  ADD COLUMN publication_manifest_hash text,
  ADD CONSTRAINT imports_publication_pair_check CHECK ((publication_manifest IS NULL) = (publication_manifest_hash IS NULL)),
  ADD CONSTRAINT imports_publication_manifest_check CHECK (jsonb_typeof(publication_manifest) = 'array'),
  ADD CONSTRAINT imports_publication_hash_check CHECK (publication_manifest_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT imports_report_pair_check CHECK ((report_object_id IS NULL) = (report_checksum IS NULL)),
  ADD CONSTRAINT imports_report_checksum_check CHECK (report_checksum ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT imports_report_object_fkey FOREIGN KEY(project_id, report_object_id, report_checksum)
    REFERENCES source_objects(project_id, id, checksum);

ALTER TABLE calculation_runs
  ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN result_version integer,
  ADD CONSTRAINT calculation_runs_warnings_check CHECK (jsonb_typeof(warnings) = 'array'),
  ADD CONSTRAINT calculation_runs_result_version_check CHECK (result_version IS NULL OR (result_version > 0 AND status = 'succeeded'));

ALTER TABLE recommendations
  ADD COLUMN evidence jsonb,
  ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT recommendations_warnings_check CHECK (jsonb_typeof(warnings) = 'array');

ALTER TABLE dispatch_intents
  ADD COLUMN cancel_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN cancel_ack_at timestamptz,
  ADD CONSTRAINT dispatch_intents_cancel_attempts_check CHECK (cancel_attempts >= 0);

CREATE FUNCTION guard_import_publication_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.publication_manifest IS NOT NULL AND
      ROW(NEW.publication_manifest,NEW.publication_manifest_hash)
      IS DISTINCT FROM ROW(OLD.publication_manifest,OLD.publication_manifest_hash))
    OR (OLD.publication_manifest IS NULL AND NEW.publication_manifest IS NOT NULL AND NEW.status <> 'validating')
    OR (OLD.report_object_id IS NOT NULL AND
      ROW(NEW.report_object_id,NEW.report_checksum) IS DISTINCT FROM ROW(OLD.report_object_id,OLD.report_checksum)) THEN
    RAISE EXCEPTION 'immutable import publication metadata';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_publication_metadata_guard BEFORE UPDATE ON imports
  FOR EACH ROW EXECUTE FUNCTION guard_import_publication_metadata();

CREATE OR REPLACE FUNCTION guard_dataset_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM imports i WHERE i.id=NEW.import_id AND i.project_id=NEW.project_id
    AND i.status='validating' AND i.dataset_version_id IS NULL AND i.quality_report IS NOT NULL
    AND COALESCE(i.publication_manifest,i.manifest)=NEW.manifest
    AND COALESCE(i.publication_manifest_hash,i.manifest_hash)=NEW.manifest_hash
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(i.quality_report->'issues','[]'::jsonb)) AS issue
      WHERE issue->>'severity'='blocking')) THEN
    RAISE EXCEPTION 'import is not validated for publication';
  END IF;
  RETURN NEW;
END $$;
