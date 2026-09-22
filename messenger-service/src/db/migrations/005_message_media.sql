-- Image attachments: the thumbnail to show, and the shape to reserve for it.
--
-- All three are supplied by the uploading client, which is the only party that
-- ever holds the bytes: file-service does not proxy blobs or interpret their
-- content (both are explicit "does not" rows in its architecture), and this
-- service never sees them either. Same reasoning that already puts the
-- filename in the message body — a recipient cannot read file metadata at all,
-- so anything the bubble needs has to travel with the message.
--
-- Nullable by design: messages sent before this migration, and clients that
-- send no derivative, render the original exactly as they do today.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS thumbnail_file_id TEXT,
  ADD COLUMN IF NOT EXISTS media_width  INTEGER CHECK (media_width  > 0),
  ADD COLUMN IF NOT EXISTS media_height INTEGER CHECK (media_height > 0);
