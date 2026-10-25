import type { Kysely, Transaction } from "kysely";
import type { DatabaseDriver } from "../../config.js";
import type { Database } from "../types.js";

/** 迁移在事务里执行，所以可以是 Kysely 或 Transaction。 */
export type MigrationDb = Kysely<Database> | Transaction<Database>;

export type MigrationContext = {
  db: MigrationDb;
  dialect: DatabaseDriver;
};

export type Migration = {
  version: number;
  /** 只用于记录与日志，不参与业务判断。 */
  name: string;
  up: (ctx: MigrationContext) => Promise<void>;
};
