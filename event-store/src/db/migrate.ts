import "dotenv/config";
import { Pool } from "pg";
import fs from "fs";
import path from "path";
import { config } from "../config";

async function migrate() {
  const pool = new Pool({ connectionString: config.DATABASE_URL });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const migrationsDir = path.join(__dirname, "migrations");
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const { rows } = await pool.query(
        "SELECT 1 FROM schema_migrations WHERE filename = $1",
        [file],
      );
      if (rows.length > 0) {
        console.log(`[migrate] skip (already applied): ${file}`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        console.log(`[migrate] applied: ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    console.log("[migrate] done");
  } finally {
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("[migrate] error:", err);
  process.exit(1);
});
