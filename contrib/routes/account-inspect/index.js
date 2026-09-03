const express = require('express');
const router = express.Router();

const blockersByAccount = {
  'account_1': [
    { type: 'open_trustline', description: 'Account has open trustlines.' }
  ],
  'account_2': [
    { type: 'open_offer', description: 'Account has active offers.' },
    { type: 'data_entry', description: 'Account has data entries.' }
  ],
  'account_3': [
    { type: 'open_trustline', description: 'Account has open trustlines.' },
    { type: 'signer', description: 'Account has additional signers.' },
    { type: 'open_offer', description: 'Account has active offers.' }
  ]
};

router.get('/:accountId', (req, res) => {
  const accountId = req.params.accountId;
  const blockers = blockersByAccount[accountId] || [];
  res.json({ accountId, blockers });
});

module.exports = router;
