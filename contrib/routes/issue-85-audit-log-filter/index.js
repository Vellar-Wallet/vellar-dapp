const logs = [
  { id: 1, actor: 'user1', action: 'login' },
  { id: 2, actor: 'user2', action: 'logout' },
  { id: 3, actor: 'user1', action: 'transfer' },
  { id: 4, actor: 'user3', action: 'login' },
  { id: 5, actor: 'user1', action: 'deposit' },
  { id: 6, actor: 'user2', action: 'transfer' },
  { id: 7, actor: 'user3', action: 'deposit' },
  { id: 8, actor: 'user4', action: 'login' },
  { id: 9, actor: 'user4', action: 'logout' },
  { id: 10, actor: 'user2', action: 'login' },
];

module.exports = function filterLogs(actor, action) {
  return logs.filter(log => {
    let match = true;
    if (actor) match = match && log.actor === actor;
    if (action) match = match && log.action === action;
    return match;
  });
};
