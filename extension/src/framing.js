'use strict';

const { BridgeError } = require('./errors');

class JsonLineDecoder {
  constructor({ maxBytes = 32 * 1024 * 1024 } = {}) {
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, bytes]);
    if (this.buffer.length > this.maxBytes && this.buffer.indexOf(0x0a) < 0) {
      throw new BridgeError('MESSAGE_TOO_LARGE', `Request exceeds ${this.maxBytes} bytes`);
    }

    const messages = [];
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        break;
      }
      if (newline > this.maxBytes) {
        throw new BridgeError('MESSAGE_TOO_LARGE', `Request exceeds ${this.maxBytes} bytes`);
      }
      const line = this.buffer.subarray(0, newline).toString('utf8').trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length === 0) {
        continue;
      }
      try {
        messages.push(JSON.parse(line));
      } catch {
        throw new BridgeError('INVALID_JSON', 'Request is not valid JSON');
      }
    }
    return messages;
  }
}

function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

module.exports = { JsonLineDecoder, encodeMessage };
