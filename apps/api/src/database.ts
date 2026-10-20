import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export interface QueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface Database extends QueryExecutor {
  transaction<Result>(work: (executor: QueryExecutor) => Promise<Result>): Promise<Result>;
}

function createExecutor(client: Pool | PoolClient): QueryExecutor {
  return {
    query: async <Row extends QueryResultRow>(queryText: string, values: readonly unknown[] = []) => {
      const result = (await client.query(queryText, [...values])) as QueryResult<Row>;
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

export function createDatabase(pool: Pool): Database {
  const executor = createExecutor(pool);

  return {
    ...executor,
    transaction: async <Result>(work: (executor: QueryExecutor) => Promise<Result>) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(createExecutor(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the operation error when the connection has already failed.
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export async function runMigrations(database: Database): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const directoryPath = fileURLToPath(new URL("../migrations/", import.meta.url));
  const fileNames = (await readdir(directoryPath))
    .filter((fileName) => /^\d+_[a-z0-9_-]+\.sql$/i.test(fileName))
    .sort();

  for (const fileName of fileNames) {
    const migration = await readFile(join(directoryPath, fileName), "utf8");
    await database.transaction(async (transaction) => {
      // Serialize the check-and-apply sequence across API replicas. The lock is
      // released automatically when the transaction commits or rolls back.
      await transaction.query("SELECT pg_advisory_xact_lock(6052252091476)");
      const alreadyApplied = await transaction.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = $1",
        [fileName],
      );
      if (alreadyApplied.rows.length > 0) return;

      await transaction.query(migration);
      await transaction.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [fileName],
      );
    });
  }
}
