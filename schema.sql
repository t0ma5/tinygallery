-- Full schema for a new install: npx wrangler d1 execute <database> --remote --file schema.sql
-- Existing installs: apply the files in migrations/ instead (see README, "Updating").

CREATE TABLE IF NOT EXISTS settings (
	key TEXT PRIMARY KEY,
	value TEXT
);

-- Private folders, opened by token. Optional password and expiry date (last valid day, YYYY-MM-DD).
CREATE TABLE IF NOT EXISTS folders (
	id INTEGER PRIMARY KEY,
	token TEXT NOT NULL UNIQUE,
	title TEXT NOT NULL,
	cover_photo_id INTEGER,
	password_hash TEXT,
	expires_at TEXT,
	downloads_off INTEGER NOT NULL DEFAULT 0,
	views INTEGER NOT NULL DEFAULT 0,
	last_viewed_at TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- folder_id NULL: on the public home page (unless hidden). sort 0 = not placed yet, shown first.
CREATE TABLE IF NOT EXISTS albums (
	id INTEGER PRIMARY KEY,
	slug TEXT NOT NULL UNIQUE,
	title TEXT NOT NULL,
	date TEXT,
	folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
	hidden INTEGER NOT NULL DEFAULT 0,
	cover_photo_id INTEGER,
	sort INTEGER NOT NULL DEFAULT 0,
	downloads_off INTEGER NOT NULL DEFAULT 0,
	views INTEGER NOT NULL DEFAULT 0,
	downloads INTEGER NOT NULL DEFAULT 0,
	photo_count INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- key: random R2 prefix, files are <key>/t (thumb), <key>/d (display), <key>/o (original).
CREATE TABLE IF NOT EXISTS photos (
	id INTEGER PRIMARY KEY,
	album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
	key TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	w INTEGER NOT NULL,
	h INTEGER NOT NULL,
	sort INTEGER NOT NULL DEFAULT 0,
	taken_at TEXT,
	hash TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Client favourites in private folders. client: random id kept in the visitor's browser.
CREATE TABLE IF NOT EXISTS favorites (
	folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
	photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
	client TEXT NOT NULL,
	name TEXT,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	PRIMARY KEY (folder_id, photo_id, client)
);

CREATE INDEX IF NOT EXISTS photos_album ON photos(album_id, sort, id);
CREATE INDEX IF NOT EXISTS albums_folder ON albums(folder_id);
CREATE INDEX IF NOT EXISTS photos_hash ON photos(album_id, hash);

-- albums.photo_count stays current through these, so pages never count photo rows.
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

-- Deleted photos and albums, kept 7 days with their files so they can be restored.
-- data: the deleted rows as JSON; keys: their R2 file prefixes, removed when the item is purged.
CREATE TABLE IF NOT EXISTS trash (
	id INTEGER PRIMARY KEY,
	kind TEXT NOT NULL,
	title TEXT,
	data TEXT NOT NULL,
	keys TEXT NOT NULL,
	deleted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
	ip TEXT NOT NULL,
	at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS login_attempts_ip ON login_attempts(ip, at);
