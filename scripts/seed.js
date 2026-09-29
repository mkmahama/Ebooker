import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db/index.js';
import { seedCatalog } from '../src/db/catalog.js';
import { Store } from '../src/store.js';
import { starsPrice } from '../src/pricing.js';

const config = loadConfig();
const db = openDb(config.dbPath);
seedCatalog(db);
for (const b of new Store(db).activeBooks()) {
  console.log(`${b.is_current_drop ? '*' : ' '} ${b.id} ${b.slug.padEnd(28)} ${String(starsPrice(b)).padStart(4)}⭐ (launch ${b.launch_price_stars} / full ${b.full_price_stars})`);
}
console.log(`Seeded ${config.dbPath}`);
