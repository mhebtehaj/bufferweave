'use strict';

class BridgeError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (data !== undefined) {
      this.data = data;
    }
  }
}

function requireObject(value, name = 'params') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError('INVALID_REQUEST', `${name} must be an object`);
  }
  return value;
}

function requireInteger(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new BridgeError('INVALID_REQUEST', `${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function requireString(value, name, { allowEmpty = false, maxLength } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new BridgeError('INVALID_REQUEST', `${name} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  if (maxLength !== undefined && [...value].length > maxLength) {
    throw new BridgeError('INVALID_REQUEST', `${name} must be at most ${maxLength} characters`);
  }
  return value;
}

module.exports = {
  BridgeError,
  requireInteger,
  requireObject,
  requireString,
};
