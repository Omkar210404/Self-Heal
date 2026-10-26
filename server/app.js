'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { openDb } = require('./db');
const { createLogger } = require('./logger');
const { secretValues, validateConfig } = require('./config');
const { IssueService } = require('./issues');
const { JobQueue } = require('./queue');
const { createIngestRouter } = require('./ingest');
const { Notifier } = require('./notify/notifier');
const { WhatsAppCloudProvider } = require('./notify/whatsapp-cloud');
const { MockWhatsAppProvider } = require('./notify/mock-whatsapp');
const { createWebhookRouter } = require('./notify/webhook');
const { EmailProvider, createEmailRouter } = require('./notify/email');
const { AIRouter, UsageTracker, createProviders } = require('./ai');
const { GitHubHost, MockGitHubHost, TokenAuth } = require('./repo');
const { Workflow } = require('./workflow');
const { createDashboard } = require('../dashboard');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

/**
 * Builds every service and the Express app. Nothing listens until start().
 * @param {{config, logger?, fetch?, mockModes?: object}} opts
 */
async function createApp({ config, logger, fetch = globalThis.fetch, mockModes = {}, emailTransport }) {
  const secrets = secretValues(config);
  logger ||= createLogger({ level: config.logLevel, secrets });
  const clock = { now: () => Date.now() };
  const db = openDb(path.join(config.dataDir, 'selfheal.db'));

  const providers = createProviders(config, { fetch, mockModes });
  const problems = validateConfig(config, { configuredAiProviders: providers.filter((p) => p.isConfigured()).map((p) => p.name) });
  if (problems.length) {
    db.close();
    const err = new Error(`selfheal cannot start. Fix these in .env:\n  - ${problems.join('\n  - ')}`);
    err.configProblems = problems;
    throw err;
  }

  const issues = new IssueService({ db, clock, logger });
  const queue = new JobQueue({ db, logger, clock, pollMs: config.queue.pollMs, backoffMs: config.queue.backoffMs });
  const w = config.whatsapp;
  const provider =
    config.notifyChannel === 'email' ? new EmailProvider({ config, transport: emailTransport })
      : config.notifyChannel === 'mock' ? new MockWhatsAppProvider({ appSecret: w.appSecret, verifyToken: w.verifyToken })
        : new WhatsAppCloudProvider({ token: w.token, phoneNumberId: w.phoneNumberId, appSecret: w.appSecret, verifyToken: w.verifyToken, apiVersion: w.apiVersion, graphUrl: w.graphUrl, fetch });
  const notifier = new Notifier({ db, queue, provider, issues, config, logger, clock });
  const usage = new UsageTracker({ db, config, clock });
  const router = new AIRouter({ providers, usage, logger, malformedRetries: config.ai.malformedRetries, maxTokens: config.ai.maxOutputTokens });
  const host = config.repoMode === 'local'
    ? new MockGitHubHost({ dataDir: config.dataDir, db, seedDir: path.join(ROOT, 'demo', 'site'), publicUrl: config.publicUrl })
    : new GitHubHost({ repo: config.github.repo, apiUrl: config.github.apiUrl, auth: new TokenAuth(config.github.token), fetch, pollMs: config.github.mergeablePollMs, pollTries: config.github.mergeablePollTries });
  if (host.init) await host.init();
  const workflow = new Workflow({ config, issues, queue, notifier, router, host, logger, secrets, clock });
  const services = { config, db, logger, issues, queue, notifier, provider, usage, router, host, workflow, providers };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.get('/health', (req, res) => res.json({ ok: true, mock: config.mock }));
  app.get('/snippet/selfheal.min.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').type('text/javascript');
    res.sendFile(path.join(ROOT, 'snippet', 'dist', 'selfheal.min.js'));
  });
  app.use(createIngestRouter({ config, issues, logger, clock, onIssue: (issue) => workflow.onNewIssue(issue) }));
  if (config.notifyChannel === 'email') app.use(createEmailRouter({ provider, notifier, config }));
  else app.use(createWebhookRouter({ provider, notifier, logger }));
  app.use('/dashboard', createDashboard(services));
  if (config.demoEnabled) app.use('/demo', demoRouter(services));
  app.get('/', (req, res) => res.redirect(config.demoEnabled ? '/demo/' : '/dashboard'));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) logger.error(`${req.method} ${req.path} failed`, err);
    res.status(status).json({ error: status === 413 ? 'Request too large' : status === 400 ? 'Bad request' : 'Internal error' });
  });

  let server = null;
  let sweepTimer = null;
  return {
    app,
    services,
    async start({ port = config.port, host: bind = config.host } = {}) {
      queue.start();
      workflow.sweep();
      sweepTimer = setInterval(() => { try { workflow.sweep(); } catch (err) { logger.error('sweep failed', err); } }, config.queue.sweepMs);
      sweepTimer.unref();
      await new Promise((resolve, reject) => { server = app.listen(port, bind, resolve).on('error', reject); });
      return server.address().port;
    },
    async stop() {
      clearInterval(sweepTimer);
      await queue.stop();
      if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())); }
      db.close();
    },
  };
}

/** /demo: the sample shop. In mock mode it is served from the mock repo's main branch, so a merge "deploys" it. */
function demoRouter({ config, host }) {
  const r = express.Router();
  r.get('/api/fail', (req, res) => res.status(500).json({ error: 'Simulated server error' }));
  r.get('/api/:name', (req, res) => res.status(404).json({ error: 'Not found' }));
  r.get('/*splat', async (req, res, next) => {
    try {
      const rel = (req.params.splat?.join?.('/') || '').replace(/\.\./g, '') || 'index.html';
      const buf = host.readFile ? await host.readFile('main', rel) : readSafe(path.join(ROOT, 'demo', 'site', rel));
      if (!buf) return res.status(404).send('Not found');
      let body = buf;
      if (rel === 'index.html') body = buf.toString('utf8').replace('YOUR_PROJECT_KEY', config.projectKey);
      res.set('Cache-Control', 'no-store').type(TYPES[path.extname(rel)] || 'application/octet-stream').send(body);
    } catch (err) {
      next(err);
    }
  });
  r.get('/', (req, res) => res.redirect('/demo/index.html'));
  return r;
}

function readSafe(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}

module.exports = { createApp };
