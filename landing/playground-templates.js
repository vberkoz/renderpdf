// Sample HTML documents for the landing page interactive playground.
let PLAYGROUND_TEMPLATES =
  (typeof window !== 'undefined' && window.PLAYGROUND_TEMPLATES) || {};

if (typeof require !== 'undefined') {
  PLAYGROUND_TEMPLATES = {
    agreement: require('./templates/agreement.js'),
    invoice: require('./templates/invoice.js'),
    receipt: require('./templates/receipt.js'),
    'boarding-pass': require('./templates/boarding-pass.js'),
    certificate: require('./templates/certificate.js'),
  };
}

if (typeof window !== 'undefined') {
  window.PLAYGROUND_TEMPLATES = PLAYGROUND_TEMPLATES;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PLAYGROUND_TEMPLATES };
}
