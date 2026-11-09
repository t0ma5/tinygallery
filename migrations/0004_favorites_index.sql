-- For installs created before favourite indexes and the stored favourite count.
-- Apply once: npx wrangler d1 execute <database> --remote --file migrations/0004_favorites_index.sql

-- A visitor's own favourites, and removing a photo's favourites when it is deleted or moved,
-- read the whole favourites table without these.
CREATE INDEX IF NOT EXISTS favorites_client ON favorites(folder_id, client);
CREATE INDEX IF NOT EXISTS favorites_photo ON favorites(photo_id);

-- Favourites per folder, kept current by the triggers below, so the spam ceiling does not count rows on every tap.
ALTER TABLE folders ADD COLUMN favorite_count INTEGER NOT NULL DEFAULT 0;
UPDATE folders SET favorite_count = (SELECT COUNT(*) FROM favorites v WHERE v.folder_id = folders.id);

CREATE TRIGGER IF NOT EXISTS favorites_count_insert AFTER INSERT ON favorites BEGIN
	UPDATE folders SET favorite_count = favorite_count + 1 WHERE id = NEW.folder_id;
END;
CREATE TRIGGER IF NOT EXISTS favorites_count_delete AFTER DELETE ON favorites BEGIN
	UPDATE folders SET favorite_count = favorite_count - 1 WHERE id = OLD.folder_id;
END;

-- Very old installs kept one home cover in 'home_cover'; it becomes a one-item 'home_covers' list.
INSERT OR IGNORE INTO settings (key, value) SELECT 'home_covers', '[' || value || ']' FROM settings WHERE key = 'home_cover' AND value GLOB '[0-9]*';
DELETE FROM settings WHERE key = 'home_cover';
