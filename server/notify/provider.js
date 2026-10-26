'use strict';
/**
 * Messaging provider interface. WhatsApp Cloud API is one implementation;
 * others (Twilio, Telegram, ...) only need to implement these methods.
 *
 * interface MessagingProvider {
 *   name: string
 *   sendText(to: string, text: string): Promise<{ id: string }>
 *   sendButtons(to: string, text: string, buttons: {id: string, title: string}[]): Promise<{ id: string }>
 *   sendTemplate(to: string, name: string, lang: string, params: string[]): Promise<{ id: string }>
 *   verifySignature(rawBody: Buffer, signatureHeader: string|undefined): boolean
 *   verifyChallenge(query: object): string|null        // webhook subscription handshake
 *   parseWebhook(body: object): { messages: Inbound[], statuses: Status[] }
 * }
 * Inbound = { id, from, timestamp, text?, buttonId?, buttonTitle? }
 * Status  = { id, status: 'sent'|'delivered'|'read'|'failed', errors: {code, title}[] }
 *
 * Send methods throw ProviderError. `windowClosed` means a free-form message
 * was refused because the 24-hour customer service window is closed.
 */
class ProviderError extends Error {
  constructor(message, { retryable = false, windowClosed = false, code = null, status = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
    this.windowClosed = windowClosed;
    this.code = code;
    this.status = status;
  }
}

module.exports = { ProviderError };
