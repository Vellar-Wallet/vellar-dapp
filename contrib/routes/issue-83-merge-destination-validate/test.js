const validate = require('./index');

console.log('Valid destination:', validate('account1', 'account2'));
console.log('Self merge rejection:', validate('account1', 'account1'));
