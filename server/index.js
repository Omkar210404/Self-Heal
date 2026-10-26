'use strict';
// Entry point: `npm start` (real mode, reads .env) or `npm run mock` (no keys needed).
const { loadConfig, loadDotEnv, secretValues } = require('./config');
const { createLogger } = require('./logger');
const { createApp } = require('./app');

async function main() {
  loadDotEnv();
  const config = loadConfig(process.env, process.argv.includes('--mock') ? { mock: true } : {});
  const logger = createLogger({ level: config.logLevel, secrets: secretValues(config) });

  process.on('unhandledRejection', (err) => logger.error('unhandled promise rejection (bug, please report)', err));
  process.on('uncaughtException', (err) => { logger.error('uncaught exception', err); process.exit(1); });

  let app;
  try {
    app = await createApp({ config, logger });
  } catch (err) {
    console.error(err.configProblems ? err.message : logger.mask(String(err.stack || err)));
    process.exit(1);
  }
  let port;
  try {
    port = await app.start();
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }
  const base = `http://localhost:${port}`;
  logger.info(`selfheal ${config.mock ? 'MOCK MODE ' : ''}listening on ${base}`);
  if (config.mock) {
    // Mock values are throwaway (generated at each start, never real credentials).
    process.stdout.write(`\n  Demo site:  ${base}/demo/\n  Dashboard:  ${base}/dashboard   password: ${config.dashboard.password}\n  Fake phone: ${base}/dashboard/phone\n\n`);
  } else {
    logger.info(`dashboard: ${base}/dashboard · webhook: ${config.publicUrl}/webhook/whatsapp · AI order: ${app.services.router.configured().map((p) => p.name).join(' → ')}`);
  }
  const shutdown = async () => { logger.info('shutting down'); await app.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
