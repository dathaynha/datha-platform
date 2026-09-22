-- How a call was set up, so history can say "Video call" rather than inferring
-- it from a duration.
--
-- DEFAULT 'audio' is what keeps this backward compatible in both directions:
-- rows projected before phase 2.5 were all audio calls, and a realtime-service
-- still publishing events without a `media` field keeps projecting cleanly.
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS media TEXT NOT NULL DEFAULT 'audio'
    CHECK (media IN ('audio', 'video'));
