const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'threads_bot.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    threads_user_id TEXT UNIQUE NOT NULL,
    username TEXT,
    access_token TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    keyword TEXT NOT NULL,
    reply_text TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    match_type TEXT DEFAULT 'contains',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS reply_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    comment_id TEXT,
    keyword_matched TEXT,
    reply_sent TEXT,
    replied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
