function calculateTotal(items, coupon) {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  if (coupon.percentOff) {
    total = total * (1 - coupon.percentOff / 100);
  }
  return Math.round(total * 100) / 100;
}

if (typeof module !== 'undefined') module.exports = { calculateTotal };
