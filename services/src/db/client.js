import { MongoClient } from 'mongodb';

/** Opens the lead engine's database. The caller closes `client` when done. */
export async function connect({ mongoUri, dbName }) {
  const client = new MongoClient(mongoUri, {
    appName: 'solutionai-lead-engine',
    serverSelectionTimeoutMS: 10_000,
    retryWrites: true,
  });
  await client.connect();
  return { client, db: client.db(dbName) };
}
