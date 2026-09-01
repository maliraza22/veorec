// Shared column types and helpers for the schema (T-102).
//
// Conventions (docs/07 §1): text PKs with typed prefixes generated app-side;
// timestamptz created_at/updated_at on every table; text + CHECK instead of
// native enums; bigint for bytes; numeric(10,3) seconds for durations.
'use strict';

const { customType, timestamp } = require('drizzle-orm/pg-core');

/** Case-insensitive text — used for email columns (extension added in 0000). */
const citext = customType({ dataType: () => 'citext' });

/** IPv4/IPv6 address. */
const inet = customType({ dataType: () => 'inet' });

const tsCol = (name) => timestamp(name, { withTimezone: true });
const createdAt = () => tsCol('created_at').notNull().defaultNow();
const updatedAt = () => tsCol('updated_at').notNull().defaultNow();

/**
 * Cross-module foreign key without a CommonJS require cycle: the target table
 * is resolved lazily, when Drizzle builds the reference, not at module load.
 */
const lazyRef = (modulePath, exportName, column = 'id') => () => require(modulePath)[exportName][column];

module.exports = { citext, inet, tsCol, createdAt, updatedAt, lazyRef };
