/**
 * Applies schema/collections.json to the lead engine's database: creates each collection with its
 * validator (or updates the validator with collMod) and creates its indexes. Safe to run any number
 * of times. An index whose definition changed is reported and left alone unless `rebuildIndexes`
 * is set, because dropping an index on a live collection should be a deliberate act.
 *
 * Rebuilding a unique index needs `allowUniqueGap` as well: between dropping the old index and
 * building the new one nothing enforces uniqueness, so a running worker can write duplicates (two
 * jobs for one idem_key) and the new index then cannot be built at all. Stop every worker and writer
 * first. If a rebuild fails, the old index is put back.
 *
 * An index in the database that the spec does not name is reported (indexes.extra), never dropped.
 */

const APPEND_ONLY = ['consents', 'activities', 'source_records', 'audit_log'];
// Added to and updated, never deleted from: an entry leaves the do-not-contact list only by an
// admin's decision, locks are released by updating them, and an export request is the record of
// who took data out of the engine.
const NO_DELETE = ['suppressions', 'locks', 'exports', 'signals'];   // a decided news item, like an export, is a record of a person's decision
export const APP_ROLE = 'leadEngineApp';

export async function migrate(db, spec, { rebuildIndexes = false, allowUniqueGap = false, log = () => {} } = {}) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const report = { created: [], updated: [], indexes: { created: 0, unchanged: 0, conflicts: [], extra: [] } };

  for (const [name, def] of Object.entries(spec.collections)) {
    const opts = { validator: def.validator, validationLevel: 'strict', validationAction: 'error' };
    if (existing.has(name)) {
      await db.command({ collMod: name, ...opts });
      report.updated.push(name);
    } else {
      await db.createCollection(name, opts);
      report.created.push(name);
    }

    const col = db.collection(name);
    const current = await col.indexes();
    const byName = new Map(current.map((ix) => [ix.name, ix]));
    const wanted = new Set((def.indexes ?? []).map((ix) => ix.name));
    for (const ix of def.indexes ?? []) {
      const have = byName.get(ix.name);
      if (have && sameIndex(have, ix)) {
        report.indexes.unchanged += 1;
        continue;
      }
      if (!have) {
        // The same key may already be indexed under another name (made by hand or by an older spec).
        // Creating it again fails with IndexOptionsConflict; report it and carry on with the rest.
        const twin = current.find((c) => !wanted.has(c.name) && sameKey(c.key, ix.key));
        if (twin) {
          report.indexes.conflicts.push(`${name}.${ix.name} (its key is already indexed as ${twin.name}; drop or rename that index)`);
          continue;
        }
        try {
          await col.createIndex(ix.key, { name: ix.name, ...(ix.options ?? {}) });
          report.indexes.created += 1;
        } catch (err) {
          if (![85, 86].includes(err?.code)) throw err; // IndexOptionsConflict, IndexKeySpecsConflict
          report.indexes.conflicts.push(`${name}.${ix.name} (${err.codeName ?? err.message})`);
        }
        continue;
      }
      if (!rebuildIndexes) {
        report.indexes.conflicts.push(`${name}.${ix.name}`);
        continue;
      }
      if ((have.unique || ix.options?.unique) && !allowUniqueGap) {
        report.indexes.conflicts.push(`${name}.${ix.name} (unique: stop every worker and writer, then rebuild with --allow-unique-gap)`);
        continue;
      }
      await col.dropIndex(ix.name);
      try {
        await col.createIndex(ix.key, { name: ix.name, ...(ix.options ?? {}) });
      } catch (err) {
        try {
          await col.createIndex(have.key, restorable(have));
        } catch (restoreErr) {
          throw new Error(`could not rebuild ${name}.${ix.name} (${err.message}) nor restore the old index (${restoreErr.message}); ${name} has no ${ix.name} index now`);
        }
        throw new Error(`could not rebuild ${name}.${ix.name} (${err.message}); the old index was restored`);
      }
      report.indexes.created += 1;
    }
    for (const c of current) if (c.name !== '_id_' && !wanted.has(c.name)) report.indexes.extra.push(`${name}.${c.name}`);
    log(`${name}: ok`);
  }

  await db.collection('_meta').updateOne(
    { _id: 'schema' },
    { $set: { version: spec.version, applied_at: new Date() } },
    { upsert: true },
  );
  return report;
}

const sameKey = (a, b) => JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));

function sameIndex(have, want) {
  const o = want.options ?? {};
  return (
    sameKey(have.key, want.key) &&
    Boolean(have.unique) === Boolean(o.unique) &&
    Boolean(have.sparse) === Boolean(o.sparse) &&
    (have.expireAfterSeconds ?? null) === (o.expireAfterSeconds ?? null) &&
    JSON.stringify(have.partialFilterExpression ?? null) === JSON.stringify(o.partialFilterExpression ?? null)
  );
}

/** The options to build an index exactly as listIndexes described it. */
function restorable(ix) {
  const out = { name: ix.name };
  for (const k of ['unique', 'sparse', 'expireAfterSeconds', 'partialFilterExpression', 'collation', 'hidden']) {
    if (ix[k] !== undefined) out[k] = ix[k];
  }
  return out;
}

/**
 * The application's database role: full read/write on working collections, find and insert only on
 * the append-only ones (so even a bug in our code cannot rewrite consent or history), and no delete
 * on the suppression list or the locks. Self-managed MongoDB accepts createRole from an admin user.
 * MongoDB Atlas does not; there the same privileges are set as a custom role (atlasCustomRole()).
 */
export function appRoleDefinition(dbName, spec) {
  const privileges = Object.keys(spec.collections).map((collection) => ({
    resource: { db: dbName, collection },
    actions: APPEND_ONLY.includes(collection)
      ? ['find', 'insert']
      : NO_DELETE.includes(collection)
        ? ['find', 'insert', 'update']
        : ['find', 'insert', 'update', 'remove'],
  }));
  privileges.push({ resource: { db: dbName, collection: '_meta' }, actions: ['find'] });
  return { role: APP_ROLE, privileges, roles: [] };
}

/**
 * The same role in the shape the Atlas Administration API takes for a custom database role
 * (POST /groups/{groupId}/customDBRoles/roles): one entry per action, upper-case action names.
 */
export function atlasCustomRole(dbName, spec) {
  const byAction = new Map();
  for (const p of appRoleDefinition(dbName, spec).privileges) {
    for (const a of p.actions) {
      if (!byAction.has(a)) byAction.set(a, []);
      byAction.get(a).push({ db: p.resource.db, collection: p.resource.collection });
    }
  }
  return { roleName: APP_ROLE, actions: [...byAction].map(([a, resources]) => ({ action: a.toUpperCase(), resources })), inheritedRoles: [] };
}

export async function ensureAppRole(db, spec) {
  const def = appRoleDefinition(db.databaseName, spec);
  const found = await db.command({ rolesInfo: APP_ROLE });
  if (found.roles?.length) {
    await db.command({ updateRole: APP_ROLE, privileges: def.privileges, roles: [] });
    return 'updated';
  }
  await db.command({ createRole: APP_ROLE, privileges: def.privileges, roles: [] });
  return 'created';
}
