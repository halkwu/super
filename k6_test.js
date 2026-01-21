import http from 'k6/http';
import { check, sleep } from 'k6';

const SERVER_URL = __ENV.SERVER_URL || 'http://localhost:4000/';

const combinedQuery = `
query GetBalanceAndTxs($identifier: String!) {
  account(identifier: $identifier) {
    id
    name
    balance
    currency
  }
  transaction(identifier: $identifier) {
    transactionId
    transactionTime
    amount
    currency
    description
    status
    balance
  }
}`;

const authMutation = `mutation Auth($payload: JSON) { auth(payload: $payload) { response identifier } }`;

const SHARED_VARS = {
  id: __ENV.ID || '911771539',
  pin: __ENV.PIN || 'BeForever.520'
};

export let options = {
  scenarios: {
        my_scenario: {
            executor: 'per-vu-iterations',
            vus: 5,
            iterations: 1, 
        },
    },
};

// Default: combined query (both account + transaction in one GraphQL operation)
export default function () {
  const params = { headers: { 'Content-Type': 'application/json' } };

  // 1) Authenticate (request session) to obtain an identifier
  const authPayload = JSON.stringify({ query: authMutation, variables: { payload: SHARED_VARS } });
  const authRes = http.post(SERVER_URL, authPayload, params);
  check(authRes, { 'auth status 200': (r) => r.status === 200 });

  console.log('authRes status:', authRes.status);
  console.log('authRes body:', authRes.body);

  let identifier = null;
  try {
    const body = JSON.parse(authRes.body);
    if (body.data && body.data.auth && body.data.auth.response === 'success') {
      identifier = body.data.auth.identifier;
    }
  } catch (e) { /* ignore parse errors */ }

  if (!identifier) {
    return; // skip if auth failed
  }

  console.log('identifier:', identifier);

  // 2) Query account + transactions using the returned identifier
  const qPayload = JSON.stringify({
  query: combinedQuery,
  variables: { identifier },
})
  const res = http.post(SERVER_URL, qPayload, params);
  check(res, {
    'query status 200': (r) => r.status === 200,
    'has account': (r) => {
      try {
        const b = JSON.parse(r.body);
        return b.data && b.data.account && b.data.account.length > 0;
      } catch (e) { return false; }
    }
  });
  sleep(1);

  console.log('query status:', res.status);
  console.log('query body:', res.body);
}