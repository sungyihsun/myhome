CREATE TABLE IF NOT EXISTS done (
  day  TEXT NOT NULL,
  id   TEXT NOT NULL,
  on_  INTEGER NOT NULL,
  by_  TEXT NOT NULL,
  at_  INTEGER NOT NULL,
  note TEXT,
  PRIMARY KEY (day, id)
);
CREATE TABLE IF NOT EXISTS items (
  id     TEXT PRIMARY KEY,
  cat    TEXT NOT NULL,
  title  TEXT NOT NULL,
  owner  TEXT NOT NULL,
  freq   TEXT NOT NULL,
  every  INTEGER NOT NULL DEFAULT 0,  -- 幾天做一次，0 = 依需求
  wd     INTEGER NOT NULL DEFAULT 0,  -- 1 = 只在週一到週五
  meal   INTEGER NOT NULL DEFAULT 0,  -- 1 = 只在當天有在家吃飯時才需要
  sort   INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS day_meta (
  day   TEXT PRIMARY KEY,
  meals INTEGER NOT NULL DEFAULT 1    -- 0 = 當天沒有在家吃飯
);
