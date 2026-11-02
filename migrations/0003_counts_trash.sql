-- For installs created before stored photo counts, the trash, "last opened" and duplicate detection.
-- Apply once: npx wrangler d1 execute <database> --remote --file migrations/0003_counts_trash.sql

-- Photo count stored on the album, kept current by the triggers below. Counting photos on every page view
-- read every photo row, which used up the free plan's daily database reads on big galleries.
ALTER TABLE albums ADD COLUMN photo_count INTEGER NOT NULL DEFAULT 0;
UPDATE albums SET photo_count = (SELECT COUNT(*) FROM photos p WHERE p.album_id = albums.id);

CREATE TRIGGER IF NOT EXISTS photos_count_insert AFTER INSERT ON photos BEGIN
	UPDATE albums SET photo_count = photo_count + 1 WHERE id = NEW.album_id;
END;
CREATE TRIGGER IF NOT EXISTS photos_count_delete AFTER DELETE ON photos BEGIN
	UPDATE albums SET photo_count = photo_count - 1 WHERE id = OLD.album_id;
END;
CREATE TRIGGER IF NOT EXISTS photos_count_move AFTER UPDATE OF album_id ON photos WHEN NEW.album_id IS NOT OLD.album_id BEGIN
	UPDATE albums SET photo_count = photo_count - 1 WHERE id = OLD.album_id;
	UPDATE albums SET photo_count = photo_count + 1 WHERE id = NEW.album_id;
END;

-- When someone last opened a private folder (UTC).
ALTER TABLE folders ADD COLUMN last_viewed_at TEXT;

-- SHA-256 of the file as chosen for upload, to skip the same photo uploaded twice into one album.
ALTER TABLE photos ADD COLUMN hash TEXT;
CREATE INDEX IF NOT EXISTS photos_hash ON photos(album_id, hash);

-- Deleted photos and albums, kept 7 days with their files so they can be restored.
CREATE TABLE IF NOT EXISTS trash (
	id INTEGER PRIMARY KEY,
	kind TEXT NOT NULL,
	title TEXT,
	data TEXT NOT NULL,
	keys TEXT NOT NULL,
	deleted_at INTEGER NOT NULL
);
