-- Supabase installs pgcrypto in the extensions schema. Existing Liri Connect
-- functions use digest(), so include that trusted schema in their runtime path.
ALTER FUNCTION register_liri_device(uuid,text,text,text,text)
  SET search_path = pg_catalog, public, extensions;
ALTER FUNCTION get_liri_tv_state(uuid,text)
  SET search_path = pg_catalog, public, extensions;
ALTER FUNCTION move_liri_session_to_tv(uuid,text)
  SET search_path = pg_catalog, public, extensions;
ALTER FUNCTION update_liri_session_from_tv(uuid,text,numeric,boolean)
  SET search_path = pg_catalog, public, extensions;
