'use strict';
const express = require('express');

/**
 * GET  /webhook/whatsapp  Meta's subscription handshake (hub.challenge).
 * POST /webhook/whatsapp  incoming messages and delivery statuses; X-Hub-Signature-256 is verified
 *                         against the raw body with the app secret before anything is parsed.
 */
function createWebhookRouter({ provider, notifier, logger }) {
  const router = express.Router();

  router.get('/webhook/whatsapp', (req, res) => {
    const challenge = provider.verifyChallenge(req.query);
    if (challenge === null) {
      logger.warn('WhatsApp webhook verification failed (wrong verify token)');
      return res.sendStatus(403);
    }
    res.type('text/plain').send(challenge);
  });

  router.post('/webhook/whatsapp', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const status = await notifier.processWebhook(raw, req.get('x-hub-signature-256'));
      res.sendStatus(status);
    } catch (err) {
      // Answer 200 so Meta does not retry a message we cannot process; the error is logged.
      logger.error('WhatsApp webhook handling failed', err);
      res.sendStatus(200);
    }
  });

  return router;
}

module.exports = { createWebhookRouter };
