/* Demo shop: each button triggers one kind of error the selfheal snippet catches. */
const out = document.getElementById('out');
const say = (t) => { out.textContent = t; };

document.getElementById('checkout').onclick = () => {
  const cart = [{ price: 19.99, quantity: 2 }, { price: 5, quantity: 1 }];
  const total = calculateTotal(cart); // no coupon -> the bug in cart.js
  say(`Total: $${total}`);
};
document.getElementById('js-error').onclick = () => {
  say('Threw an uncaught error');
  null.trigger();
};
document.getElementById('promise').onclick = () => {
  say('Rejected a promise nobody handles');
  Promise.reject(new Error('Payment service timed out'));
};
document.getElementById('fetch500').onclick = async () => {
  const r = await fetch('/demo/api/fail');
  say(`fetch returned ${r.status}`);
};
document.getElementById('fetch404').onclick = async () => {
  const r = await fetch('/demo/api/missing-product');
  say(`fetch returned ${r.status}`);
};
document.getElementById('xhr').onclick = () => {
  const x = new XMLHttpRequest();
  x.open('GET', '/demo/api/fail');
  x.onloadend = () => say(`XHR returned ${x.status}`);
  x.send();
};
document.getElementById('image').onclick = () => {
  const img = new Image();
  img.src = '/demo/images/missing-banner.png';
  document.body.appendChild(img);
  say('Tried to load a missing image');
};
