import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import SQLite from "better-sqlite3";
import { Kysely, MysqlDialect, PostgresDialect, SqliteDialect } from "kysely";
import mysql from "mysql2";
import pg from "pg";
import type { DatabaseDriver } from "../config.js";
import type { Database } from "./types.js";

export type Db = Kysely<Database>;

/**
 * PostgreSQL 的 int8 默认按字符串返回；本项目约定计数/时间戳在应用层是
 * number（< 2^53），所以统一解析成 number。MySQL 的 BIGINT 在 mysql2
 * 默认配置下也是 number。SQLite 本身返回 number。
 */
pg.types.setTypeParser(20, (value) => Number(value));

export function resolveSqlitePath(url: string): string {
  if (url === ":memory:" || url === "file::memory:") return ":memory:";
  const raw = url.startsWith("file:") ? url.slice("file:".length) : url;
  if (raw === ":memory:") return ":memory:";
  return resolve(process.cwd(), raw);
}

export function createDb(options: { driver: DatabaseDriver; url: string }): Db {
  switch (options.driver) {
    case "sqlite": {
      const filePath = resolveSqlitePath(options.url);
      if (filePath !== ":memory:") {
        mkdirSync(dirname(filePath), { recursive: true });
      }
      const sqlite = new SQLite(filePath);
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("foreign_keys = ON");
      return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
    }
    case "mysql":
    case "mariadb": {
      // MariaDB 走同一 mysql2 路径；BIGINT 在默认配置下解析为 number。
      const pool = mysql.createPool(options.url);
      return new Kysely<Database>({ dialect: new MysqlDialect({ pool }) });
    }
    case "postgres": {
      const pool = new pg.Pool({ connectionString: options.url, max: 10 });
      return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    }
  }
}
