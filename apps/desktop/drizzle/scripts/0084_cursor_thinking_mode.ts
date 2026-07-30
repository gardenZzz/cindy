import type Database from 'better-sqlite3';

function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const sessionColumns = new Set(tableColumnNames(db, 'sessions'));
  if (!sessionColumns.has('thinking_mode')) {
    db.exec('ALTER TABLE sessions ADD COLUMN thinking_mode integer DEFAULT true NOT NULL');
  }
}

module.exports = { run };
