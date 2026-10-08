/** Trusted local provisioning against the same database the server uses. */
import { AccessTokenManager } from "@zackbart/connecta/auth/access-tokens";
import { openSqlite, sqliteStorage } from "@zackbart/connecta/sqlite";

const name = process.argv[2];
if (!name || process.argv.length !== 3) {
  throw new Error('Usage: npm run provision-token -- "machine-name"');
}
const database = openSqlite(process.env.CONNECTA_DATABASE || "./.connecta.sqlite");
try {
  const manager = new AccessTokenManager(sqliteStorage(database));
  const { token } = await manager.create(name, "local-provisioning");
  // The secret is returned once. Keep stdout private; storage holds its hash.
  process.stdout.write(`${token}\n`);
} finally {
  database.close();
}
