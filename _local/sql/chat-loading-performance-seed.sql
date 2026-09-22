-- =============================================================================
-- Chat loading performance seed — chatbot_service Postgres (run from DBeaver)
--
-- Targets GET /conversations (aggregate + sort) and GET /conversations/:id/messages
-- (keyset-ish pagination + selectinload(Message.files)).
--
-- Attachment rows (message_files): this seed does not insert them. Random file_id UUIDs would not
-- exist in file-service.files, so the UI would GET /api/files/:id/download-url → 404 on every tile.
-- To stress JOINs on message_files, add inserts whose file_id matches real uploads.
--
-- BEFORE RUNNING
--   1. Connect DBeaver to the same DB as chatbot-service (see _local/README.md).
--   2. In the DECLARE block below, set v_owner_id to your account’s owner id
--      (must match api-gateway X-Owner-ID), e.g. google_<sub> or entra_<oid>.
--   3. Optionally tune conversation / message counts.
--
-- IDEMPOTENCY
--   Deletes existing seed data for that owner: conversations whose title starts
--   with '[perf-load]' (CASCADE removes messages and message_files).
--
-- CLEANUP ONLY (optional)
--   Uncomment the final standalone DELETE block at the bottom, set v_owner_id
--   in your session, or replace the literal in the WHERE clause.
-- =============================================================================

DO $$
DECLARE
  -- ---- required -----------------------------------------------------------
  v_owner_id           text := 'entra_3dd7fa39-bd8c-40ae-8aaa-cdcc86eb918f'; -- gateway X-Owner-ID

  -- ---- volume knobs -------------------------------------------------------
  v_shallow_conv_count integer := 120;   -- sidebar / list_conversations stress
  v_msgs_per_shallow   integer := 8;     -- short threads
  v_deep_conv_count    integer := 3;     -- heavy threads (appear near top of list)
  v_msgs_per_deep      integer := 350;   -- pagination + join message_files stress

  i                    integer;
  j                    integer;
  v_conv               uuid;
  v_msg                uuid;
  v_ts                 timestamptz;
  v_role               text;
  v_body               text;
BEGIN
  IF v_owner_id LIKE '%REPLACE_WITH%' THEN
    RAISE EXCEPTION 'Edit v_owner_id (DECLARE block) to your real owner id before running.';
  END IF;

  IF length(v_owner_id) > 128 THEN
    RAISE EXCEPTION 'owner_id exceeds 128 characters.';
  END IF;

  DELETE FROM conversations
  WHERE owner_id = v_owner_id
    AND title LIKE '[perf-load]%';

  ---------------------------------------------------------------------------
  -- Shallow conversations: many rows for list endpoint + small threads
  ---------------------------------------------------------------------------
  FOR i IN 1..v_shallow_conv_count LOOP
    v_conv := gen_random_uuid();
    v_ts := now() - make_interval(mins => v_shallow_conv_count - i + 1);

    INSERT INTO conversations (id, owner_id, title, created_at)
    VALUES (
      v_conv,
      v_owner_id,
      '[perf-load] shallow ' || i,
      v_ts - interval '10 minutes'
    );

    FOR j IN 1..v_msgs_per_shallow LOOP
      v_msg := gen_random_uuid();
      v_ts := v_ts + make_interval(secs => j);
      v_role := CASE WHEN mod(j, 2) = 1 THEN 'user' ELSE 'assistant' END;
      v_body :=
        '[' || v_role || '] shallow conv=' || i || ' msg=' || j || E'\n'
        || repeat('Lorem ipsum dolor sit amet. ', 4 + mod(j, 10));

      INSERT INTO messages (
        id,
        conversation_id,
        role,
        content,
        created_at,
        generation_error_code,
        generation_error_summary,
        generation_error_detail
      )
      VALUES (
        v_msg,
        v_conv,
        v_role,
        v_body,
        v_ts,
        NULL,
        NULL,
        NULL
      );

    END LOOP;
  END LOOP;

  ---------------------------------------------------------------------------
  -- Deep threads: fewer conversations, many messages (scroll / pagination)
  ---------------------------------------------------------------------------
  FOR i IN 1..v_deep_conv_count LOOP
    v_conv := gen_random_uuid();
    v_ts := now() - make_interval(secs => 30 + i * 15);

    INSERT INTO conversations (id, owner_id, title, created_at)
    VALUES (
      v_conv,
      v_owner_id,
      '[perf-load] DEEP pagination #' || i,
      v_ts - interval '1 hour'
    );

    FOR j IN 1..v_msgs_per_deep LOOP
      v_msg := gen_random_uuid();
      v_ts := v_ts + make_interval(secs => 1);
      v_role := CASE WHEN mod(j, 2) = 1 THEN 'user' ELSE 'assistant' END;

      IF v_role = 'assistant' AND mod(j, 211) = 0 THEN
        v_body :=
          '[' || v_role || '] deep conv=' || i || ' msg=' || j
          || E'\n(simulated failure)\n'
          || repeat('Detail line. ', 40);
        INSERT INTO messages (
          id,
          conversation_id,
          role,
          content,
          created_at,
          generation_error_code,
          generation_error_summary,
          generation_error_detail
        )
        VALUES (
          v_msg,
          v_conv,
          v_role,
          v_body,
          v_ts,
          'upstream_timeout',
          'The model took too long to respond.',
          'Synthetic perf seed row.'
        );
      ELSE
        v_body :=
          '[' || v_role || '] deep conv=' || i || ' msg=' || j || E'\n'
          || repeat('Paragraph text for payload weight. ', 12 + mod(j, 9));

        INSERT INTO messages (
          id,
          conversation_id,
          role,
          content,
          created_at,
          generation_error_code,
          generation_error_summary,
          generation_error_detail
        )
        VALUES (
          v_msg,
          v_conv,
          v_role,
          v_body,
          v_ts,
          NULL,
          NULL,
          NULL
        );
      END IF;

    END LOOP;
  END LOOP;

  RAISE NOTICE
    'perf-load seed complete for owner=% | shallow=% conv × % msgs | deep=% conv × % msgs',
    v_owner_id,
    v_shallow_conv_count,
    v_msgs_per_shallow,
    v_deep_conv_count,
    v_msgs_per_deep;
END $$;

-- -----------------------------------------------------------------------------
-- CLEANUP ONLY — replace owner literal, select and execute in DBeaver
-- -----------------------------------------------------------------------------
-- DELETE FROM conversations
-- WHERE owner_id = 'entra_3dd7fa39-bd8c-40ae-8aaa-cdcc86eb918f'
--   AND title LIKE '[perf-load]%';
