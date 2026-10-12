# POS SaaS — Prueba de concepto

Prueba de concepto del POS SaaS para comercio minorista argentino definido en el análisis
**"POS SaaS tipo Cobrando.app — Diseño y Estimación"** y en el **Mapa de módulos POS**
(12/10/2026). El diseño es clean-room: parte solo de la funcionalidad pública relevada, no
de código ni APIs de terceros.

La PoC no busca cubrir los 17 módulos. Ataca los tres frentes que el análisis marca como
**la complejidad real** del producto y deja funcionando, de punta a punta, el circuito del
MVP: abrir caja → vender → cobrar → fiar → facturar → cerrar caja → reportes.

| Hipótesis del diseño | Cómo se valida en la PoC | Evidencia |
|---|---|---|
| **Offline-first**: el kiosco sigue vendiendo con internet inestable y nunca se pierde una venta | PWA con service worker + IndexedDB; la venta se confirma local con UUID v7 del cliente y viaja por una cola de operaciones; el servidor aplica cada operación de forma idempotente | `test/sync.test.js`, demo con "Simular sin conexión" |
| **Facturación ARCA con contingencia**: la venta nunca espera a ARCA | Evento "venta confirmada" → comprobante pendiente → worker con cupo atómico, reintentos con backoff, rechazos visibles y nota de crédito al anular, todo detrás de un puerto fiscal intercambiable | `test/fiscal.test.js`, bandeja de Facturación |
| **Aislamiento multi-tenant** | `tenant_id` en todas las tablas, tomado solo de la sesión; rechazo de ids de otro comercio en el sync | `test/tenancy.test.js` |

## Cómo correrla

Requiere **Node.js 22.5 o superior**. No tiene dependencias externas (`node:sqlite`, `node:http`,
`node:test` y JavaScript del navegador sin build).

```bash
cd pos-poc
npm start          # http://localhost:3000 (crea data/pos.db con datos de demo la primera vez)
npm test           # 28 pruebas automáticas
npm run reset      # borra la base local y la recrea con datos de demo
```

Usuarios de demo (contraseña `demo1234`):

| Usuario | Comercio | Rol | Para qué sirve |
|---|---|---|---|
| `dueno@demo.ar` | Kiosco La Esquina (RI, plan IA, factura electrónica) | Dueño | Ver todo |
| `cajero@demo.ar` | Kiosco La Esquina | Cajero | Ver permisos reducidos (no anula, no ve reportes) |
| `almacen@demo.ar` | Almacén Don Pepe (Monotributo, plan Esencial) | Dueño | Comprobar aislamiento y Factura C |

El kiosco trae 14 días de historial (≈360 ventas, turnos cerrados, fiados) generado con el
mismo sync que usa la caja, así que reportes y cuentas corrientes tienen datos desde el inicio.

Variables de entorno opcionales:

| Variable | Default | Uso |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP |
| `DB_FILE` | `data/pos.db` | Archivo SQLite |
| `FISCAL_FAIL_RATE` | `0` | Probabilidad (0–1) de caída del integrador simulado, para ver reintentos |
| `FISCAL_BACKOFF_MS` | `5000` | Espera base del backoff exponencial (tope 15 min) |
| `FISCAL_IDENTIFY_THRESHOLD_ARS` | `500000` | Monto desde el que el simulador rechaza una Factura B sin identificar al receptor (ilustrativo) |

## Versión para abrir en el navegador (artifact)

`artifact/` empaqueta la PoC en un único HTML que corre sin servidor: el mismo código de
`server/` se ejecuta dentro de la página sobre SQLite compilado a JavaScript (sql.js, build
asm.js sin WebAssembly) y el cliente le habla por un transporte en memoria en lugar de HTTP.
Los datos de ese "servidor" y la base local de la caja quedan en el IndexedDB de quien la abre.

```bash
npm i --no-save esbuild@0.24.0 sql.js@1.10.3
npm run build:artifact     # genera dist/pos-poc.html (≈1,4 MB)
```

Diferencias con la versión local: sin service worker, sin cámara ni diálogo de impresión
(el visor no los permite), el CSV de ventas se muestra para copiar en lugar de descargarse
y el hash de contraseñas es un mezclador simple (los usuarios de demo viven en el navegador).

## Guion de demo (5 minutos)

1. Ingresar como `dueno@demo.ar` → **Caja** → abrir turno con fondo inicial.
2. **Vender**: escribir el código EAN que muestra la pantalla y Enter; después la etiqueta de
   balanza (se decodifica el peso embebido); agregar un **Monto rápido**. Cobrar con pago mixto
   (efectivo + Mercado Pago) y ver el vuelto. Se imprime el ticket.
3. Activar **Simular sin conexión** (corta todas las llamadas al servidor). Vender a
   **cuenta corriente** a "Rosa Gómez" y otra venta con Mercado Pago. El indicador muestra
   las operaciones pendientes; Reportes y Productos avisan que necesitan red.
4. Desactivar la simulación: la cola se vacía sola. En **Facturación** aparecen las facturas B
   autorizadas con CAE y QR, incluidas las de las ventas hechas sin red.
5. **Clientes**: Rosa tiene el saldo actualizado, la antigüedad de la deuda y el botón de
   recordatorio por WhatsApp.
6. **Caja**: registrar un retiro, contar por billetes y cerrar el turno con una diferencia →
   aparece en **Avisos**.
7. Opcional: reiniciar con `FISCAL_FAIL_RATE=0.5 npm start` para ver comprobantes pendientes
   que se reintentan solos; anular una venta facturada desde Caja para ver la nota de crédito.

## Cobertura respecto del diseño

| Módulo | Estado en la PoC | Qué incluye / qué falta |
|---|---|---|
| M1 Plataforma y tenancy | Parcial | Login, sesiones de 12 h, 4 roles con permisos, auditoría de cada acción, alta de usuarios. Falta: registro self-service, wizard por rubro, MFA |
| M2 Catálogo | Parcial | Unidad, peso y monto libre; varios códigos por producto; PLU de balanza. Falta: variantes, combos, import Excel/CSV, base maestra de EAN |
| M3 Punto de venta | **Sí** | Búsqueda incremental, lector USB (teclado) y cámara (`BarcodeDetector`), monto rápido, pagos mixtos, vuelto, ticket 80 mm, anulación. Falta: descuentos, pedidos por mesa |
| M4 Operación offline | **Sí (núcleo)** | PWA instalable, base local, cola ordenada, sync idempotente, stock eventualmente consistente con negativos permitidos. Falta: delta-sync por `updated_at`, prueba de 24 h sin red, resolución de conflictos de precio |
| M5 Inventario y compras | Parcial | Stock como suma de movimientos, mínimos con aviso, recuento, compra a proveedor con actualización de costo/precio por margen. Falta: órdenes de compra y recepción |
| M6 Caja y turnos | **Sí** | Apertura con fondo, ingresos/retiros con motivo, arqueo por denominación, esperado recalculado en el servidor, turno cerrado inmutable, aviso de diferencias |
| M7 Clientes y cuentas corrientes | **Sí** | Fiado con límite de crédito, pagos parciales aplicados FIFO, antigüedad, recordatorio wa.me, alta sin conexión |
| M8 Reportes | **Sí** | KPIs vs. período anterior, ventas por hora, por medio de pago, top/bottom, margen estimado con costo histórico, export CSV |
| M9 Facturación electrónica | **Sí (simulada)** | A/B/C y notas de crédito, neto/IVA discriminado, numeración correlativa, cupo mensual atómico, reintentos, bandeja, QR fiscal. El integrador es un **simulador**: falta el adaptador real (TusFacturasApp o WSAA+WSFEv1), alta de certificado y alertas de vencimiento |
| M10 Impresión y periféricos | Parcial | Ticket por diálogo de impresión. Falta: ESC/POS por WebUSB/Web Serial, cajón |
| M11 Balanzas | Parcial | Decodificación de etiquetas EAN-13 con peso o importe (formato configurable). Falta: lectura por puerto serie |
| M12 Catálogo online | No | Fase 2 |
| M13 Suscripción SaaS | Parcial | Planes Esencial/Pro/IA, trial, límites de productos y usuarios. Falta: cobro recurrente y webhooks |
| M14 IA | Parcial | Solo "sin rotación" (regla determinística). OCR de facturas y precios sugeridos son Fase 3 |
| M15 Backoffice interno | No | Fase 2 |
| M16 Notificaciones | Parcial | Avisos dentro de la app por eventos. Falta: email transaccional |
| M17 Sitio comercial | No | Fase 4 |

## Arquitectura de la PoC frente a la de producción

La PoC respeta la forma del diseño (monolito modular multi-tenant + PWA offline-first +
adaptadores); cambia solo la tecnología de algunas piezas para que corra sin infraestructura.

| Pieza | En la PoC | En producción (según el diseño) |
|---|---|---|
| Base de datos | SQLite embebido; aislamiento por `tenant_id` en la capa de repositorio | PostgreSQL gestionado con row-level security + tests de fuga entre tenants |
| Comunicación entre módulos | Bus de eventos en memoria, después del commit | Cola de mensajes con workers idempotentes y dead-letter (patrón outbox) |
| Facturación | `MockIntegratorAdapter` detrás del puerto `authorize()` | Adaptador TusFacturasApp o WSAA + WSFEv1, certificados cifrados con KMS |
| Worker fiscal | `setInterval` en el mismo proceso | Proceso/función separada; candidato a servicio propio |
| Cliente | JavaScript sin framework ni build | React/Vue/Svelte + Dexie/RxDB |
| Sync | Push de lotes ordenados + pull completo | Push idéntico + pull incremental por `updated_at` |

```
pos-poc/
├── server/
│   ├── server.js            arranque HTTP + worker fiscal
│   ├── app.js               rutas, estáticos, composición de módulos
│   ├── db.js                esquema (todas las tablas con tenant_id)
│   ├── core.js              errores, bus de eventos, roles, auditoría, avisos
│   ├── seed.js              comercios, usuarios, catálogo y 14 días de historial
│   └── modules/             un archivo por módulo: platform, subscription, catalog,
│                            inventory, customers, cash, sync, fiscal, reports, notifications
├── public/
│   ├── index.html, styles.css, sw.js, manifest.webmanifest
│   ├── lib/                 código compartido cliente/servidor: uuidv7, balanzas, dinero
│   └── js/                  app.js (shell), store.js (IndexedDB), syncer.js (cola), api.js, views/
└── test/                    node:test — sync, tenancy, fiscal, HTTP, librerías
```

### Reglas de diseño que la PoC implementa tal cual

- Importes en centavos enteros; precios con IVA incluido; el neto e IVA se discriminan al facturar.
- El stock nunca se edita: es la suma de movimientos append-only (venta, anulación, compra, ajuste).
- El saldo de cuenta corriente nunca se edita: es la suma de asientos (cargo, pago, reversión).
- Una venta ya cobrada no se rechaza por stock; sí se rechaza si referencia datos de otro comercio.
- El comprobante fiscal nunca se borra: anular una venta facturada emite nota de crédito.
- El turno cerrado es inmutable; el efectivo esperado lo recalcula el servidor.

## Límites conocidos

- Sin HTTPS ni rate limiting: es para correr local. El service worker requiere `localhost` o HTTPS.
- El "esperado" que muestra la caja sin red es un estimado local; el definitivo lo calcula el servidor al sincronizar.
- Si dos cajas venden el mismo producto sin red, el stock queda eventualmente consistente (puede quedar negativo con aviso), tal como define el diseño.
- La zona horaria de reportes está fija en Argentina (UTC−3).
