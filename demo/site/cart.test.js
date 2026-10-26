const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateTotal } = require('./cart');

test('applies a percentage coupon', () => {
  assert.equal(calculateTotal([{ price: 10, quantity: 2 }], { percentOff: 10 }), 18);
});

test('works without a coupon', () => {
  assert.equal(calculateTotal([{ price: 10, quantity: 2 }, { price: 2.5, quantity: 1 }]), 22.5);
});
