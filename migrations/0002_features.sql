-- For installs created before photo ordering, favourites, folder passwords, expiry, counts and download switches.
-- Apply once: npx wrangler d1 execute <database> --remote --file migrations/0002_features.sql

ALTER TABLE folders ADD COLUMN password_hash TEXT;
ALTER TABLE folders ADD COLUMN expires_at TEXT;
ALTER TABLE folders ADD COLUMN downloads_off INTEGER NOT NULL DEFAULT 0;
ALTER TABLE folders ADD COLUMN views INTEGER NOT NULL DEFAULT 0;

ALTER TABLE albums ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE albums ADD COLUMN downloads_off INTEGER NOT NULL DEFAULT 0;
ALTER TABLE albums ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE albums ADD COLUMN downloads INTEGER NOT NULL DEFAULT 0;

ALTER TABLE photos ADD COLUMN taken_at TEXT;

CREATE TABLE IF NOT EXISTS favorites (
	folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
	photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
	client TEXT NOT NULL,
	name TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (folder_id, photo_id, client)
);
