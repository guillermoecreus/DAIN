import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { startFiscalWorker } from './modules/fiscal.js';
import { seed } from './seed.js';

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || fileURLToPath(new URL('../data/pos.db', import.meta.url));

const app = createApp({ dbFile: DB_FILE });
if (!app.ctx.db.prepare('SELECT 1 FROM tenants LIMIT 1').get()) seed(app.ctx);
startFiscalWorker(app.ctx);

createServer(app.handle).listen(PORT, () => {
  console.log(`POS PoC en http://localhost:${PORT}`);
  console.log('Usuarios demo: dueno@demo.ar / cajero@demo.ar / almacen@demo.ar — contraseña: demo1234');
});
