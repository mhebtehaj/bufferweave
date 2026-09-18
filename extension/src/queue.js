'use strict';

class KeyedQueue {
  constructor() {
    this.tails = new Map();
  }

  run(key, operation) {
    const previous = this.tails.get(key) || Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined).finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    this.tails.set(key, tail);
    return result;
  }
}

module.exports = { KeyedQueue };
