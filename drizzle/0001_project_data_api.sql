-- Existing imports remain immutable; only a newly reserved upload may freeze once.
ALTER TABLE imports ADD COLUMN manifest_frozen boolean NOT NULL DEFAULT true;
ALTER TABLE imports ADD CONSTRAINT imports_provisional_state CHECK (manifest_frozen OR (status='uploaded' AND dataset_version_id IS NULL));
CREATE OR REPLACE FUNCTION guard_import_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.source_object_id,NEW.checksum,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.source_object_id,OLD.checksum,OLD.created_at)
     OR NEW.state_version <> OLD.state_version+1
     OR (OLD.dataset_version_id IS NOT NULL AND (NEW.dataset_version_id IS DISTINCT FROM OLD.dataset_version_id OR NEW.status <> 'ready'))
     OR (OLD.manifest_frozen AND NOT NEW.manifest_frozen)
     OR (ROW(NEW.manifest,NEW.manifest_hash,NEW.adapter_version,NEW.schema_version) IS DISTINCT FROM ROW(OLD.manifest,OLD.manifest_hash,OLD.adapter_version,OLD.schema_version)
       AND NOT (NOT OLD.manifest_frozen AND NEW.manifest_frozen AND OLD.status='uploaded' AND NEW.status='awaiting-validation'))
     OR (NOT OLD.manifest_frozen AND NEW.manifest_frozen AND NEW.status <> 'awaiting-validation') THEN
    RAISE EXCEPTION 'immutable import identity or stale state version';
  END IF;
  RETURN NEW;
END $$;
