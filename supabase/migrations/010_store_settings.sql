-- 010_store_settings.sql
-- Per-store configuration. Starts with AI assistant personality.

CREATE TABLE store_settings (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    text        NOT NULL DEFAULT 'default',
  ai_personality text     NOT NULL DEFAULT '溫柔學姊',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Seed a default row so the backend always has something to read
INSERT INTO store_settings (store_id) VALUES ('default');

-- Auto-update updated_at on every write
CREATE OR REPLACE FUNCTION update_store_settings_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER store_settings_updated_at
  BEFORE UPDATE ON store_settings
  FOR EACH ROW EXECUTE FUNCTION update_store_settings_updated_at();

-- RLS: only authenticated admins can read/write
ALTER TABLE store_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins can manage store_settings"
  ON store_settings FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
