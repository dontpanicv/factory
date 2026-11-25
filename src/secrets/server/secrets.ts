import type { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Secrets: credentials by the name of an environment variable. A value never leaves the server,
 * except into a sandbox or a shared resource that has the secret. In the database a value is
 * sealed (AES-256-GCM).
 */

export const SECRETS_TABLE = `CREATE TABLE secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`;

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const SEALED = "v1:";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** The key that seals the secrets, from a passphrase of any length. */
export const secretKey = (passphrase: string) =>
  createHash("sha256").update(passphrase).digest();

/**
 * The passphrase that seals the secrets: `FACTORY_SECRET_KEY`, or a key file that Factory makes in
 * its data directory. With the key file, a copy of the database alone does not give the secrets;
 * with `FACTORY_SECRET_KEY`, a copy of the whole data directory does not.
 */
export const sealPassphrase = (dataDir: string) => {
  const fromEnv = process.env.FACTORY_SECRET_KEY;
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const file = join(dataDir, "secret.key");
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(KEY_BYTES).toString("base64"), {
      mode: 0o600,
    });
  }
  return readFileSync(file, "utf8").trim();
};

export interface Secrets {
  /** The names only. */
  readonly names: () => string[];
  readonly remove: (name: string) => void;
  /** Seal the secrets that an older Factory kept as plain text. */
  readonly sealAll: () => void;
  readonly set: (name: string, value: string) => void;
  readonly value: (name: string) => string | undefined;
  /** The secrets of these names that exist, as environment variables. */
  readonly values: (wanted: readonly string[]) => Record<string, string>;
}

export const secretsOf = (db: Database, key: Buffer): Secrets => {
  const seal = (plain: string) => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const sealed = Buffer.concat([
      cipher.update(plain, "utf8"),
      cipher.final(),
    ]);
    return `${SEALED}${[iv, cipher.getAuthTag(), sealed].map((part) => part.toString("base64")).join(":")}`;
  };
  const open = (stored: string) => {
    if (!stored.startsWith(SEALED)) {
      return stored;
    }
    const [iv = "", tag = "", sealed = ""] = stored
      .slice(SEALED.length)
      .split(":");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed, "base64")),
      decipher.final(),
    ]).toString("utf8");
  };
  const value = (name: string) => {
    const stored = db
      .query<{ value: string }, [string]>(
        "SELECT value FROM secrets WHERE name = ?"
      )
      .get(name)?.value;
    return stored === undefined ? undefined : open(stored);
  };
  return {
    names: () =>
      db
        .query<{ name: string }, []>("SELECT name FROM secrets ORDER BY name")
        .all()
        .map((row) => row.name),
    remove: (name) => {
      db.query("DELETE FROM secrets WHERE name = ?").run(name);
    },
    sealAll: () => {
      const plain = db
        .query<{ name: string; value: string }, [string]>(
          "SELECT name, value FROM secrets WHERE value NOT LIKE ?"
        )
        .all(`${SEALED}%`);
      for (const row of plain) {
        db.query("UPDATE secrets SET value = ? WHERE name = ?").run(
          seal(row.value),
          row.name
        );
      }
    },
    set: (name, secret) => {
      if (!SECRET_NAME.test(name)) {
        throw new Error(
          "A secret has the name of an environment variable: GITHUB_TOKEN."
        );
      }
      db.query(
        `INSERT INTO secrets (name, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(name, seal(secret), Date.now());
    },
    value,
    values: (wanted) => {
      const env: Record<string, string> = {};
      for (const name of wanted) {
        const secret = value(name);
        if (secret !== undefined) {
          env[name] = secret;
        }
      }
      return env;
    },
  };
};
