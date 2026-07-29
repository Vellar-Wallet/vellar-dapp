const filterLogs = require('./index');

console.log('Actor only:', filterLogs('user1'));
console.log('Actor and action:', filterLogs('user1', 'login'));
