// Applies the database schema (database/init/*.sql) idempotently against
// DATABASE_URL.
//
// The Postgres container runs database/init/*.sql automatically ONLY on a fresh
// data volume. If you already have a persisted ./.data/postgres that predates the
// init scripts, the tables will not exist. Running the same SQL files here keeps
// backend startup aligned with the database container's initialization path.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Where to find the init SQL: mounted into the container at /app/database-init,
// or in the repo at ../../database/init for local runs.
const CANDIDATE_DIRS = ['/app/database-init', path.resolve(__dirname, '../../database/init')];

function findSqlDir() {
  for (const dir of CANDIDATE_DIRS) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      continue;
    }
    if (fs.readdirSync(dir).some((file) => file.endsWith('.sql'))) {
      return dir;
    }
  }
  return null;
}

function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarQuoteTag = null;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1] ?? '';

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        current += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (dollarQuoteTag) {
      if (sql.startsWith(dollarQuoteTag, i)) {
        current += dollarQuoteTag;
        i += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
        continue;
      }
      current += char;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (char === '-' && next === '-') {
        inLineComment = true;
        i += 1;
        continue;
      }
      if (char === '/' && next === '*') {
        inBlockComment = true;
        i += 1;
        continue;
      }
      if (char === '$') {
        const remainder = sql.slice(i);
        const match = remainder.match(/^\$[A-Za-z0-9_]*\$/);
        if (match) {
          dollarQuoteTag = match[0];
          current += dollarQuoteTag;
          i += dollarQuoteTag.length - 1;
          continue;
        }
      }
    }

    if (char === "'" && !inDoubleQuote) {
      current += char;
      if (inSingleQuote && next === "'") {
        current += next;
        i += 1;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      current += char;
      if (inDoubleQuote && next === '"') {
        current += next;
        i += 1;
        continue;
      }
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === ';' && !inSingleQuote && !inDoubleQuote) {
      const statement = current.trim();
      if (statement) {
        statements.push(statement);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const trailing = current.trim();
  if (trailing) {
    statements.push(trailing);
  }
  return statements;
}

async function main() {
  const dir = findSqlDir();
  if (!dir) {
    console.error('Could not locate database/init SQL files. Looked in:', CANDIDATE_DIRS);
    process.exit(1);
  }

  const files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  console.log(`Applying schema from ${dir}: ${files.join(', ')}`);

  // The migrations are deliberately idempotent. PostgreSQL emits a NOTICE for
  // every existing table, column, and index on each backend restart; suppress
  // those expected notices while preserving warnings and errors.
  await prisma.$executeRawUnsafe("SET client_min_messages = 'warning'");

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!sql.trim()) {
      console.log(`  ok ${file} (empty)`);
      continue;
    }
    const statements = splitStatements(sql);
    for (const statement of statements) {
      await prisma.$executeRawUnsafe(statement);
    }
    console.log(`  ok ${file}`);
  }

  console.log('Schema is up to date.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
