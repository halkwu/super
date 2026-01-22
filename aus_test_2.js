const http = require('http');
const https = require('https');
const { URL } = require('url');
const readline = require('readline');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:4000/';

const SHARED_VARS = {
  id: process.env.ID || 'hwu@ironflytechnologies.com',
  pin: process.env.PIN || 'BeForever.520',
};

const authMutation = `
mutation Auth($payload: JSON) {
  auth(payload: $payload) {
    response
    identifier
  }
}
`;

const verifyMutation = `
mutation Verify($payload: JSON) {
  auth(payload: $payload) {
    response
  }
}
`;

const resendOtpMutation = `
mutation ResendOtp($payload: JSON) {
  auth(payload: $payload) {
    response
  }
}
`;

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
}
`;

function postJson(urlString, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = JSON.stringify(body);

    const opts = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runUser(userIndex) {
  console.log(`\n=== User ${userIndex} START ===`);

  const authRes = await postJson(SERVER_URL, {
    query: authMutation,
    variables: { payload: SHARED_VARS },
  });

  console.log(`[User ${userIndex}] Auth status:`, authRes.status);
  console.log(`[User ${userIndex}] Auth body:`, authRes.body);

  const authBody = JSON.parse(authRes.body);
  const authData = authBody?.data?.auth;

  if (!authData || authData.response === 'fail') {
    console.log(`[User ${userIndex}] Auth failed`);
    return;
  }

  let identifier = authData.identifier;

  if (authData.response === 'need_otp') {
  let attempts = 0;
  let verified = false;

  while (attempts < 2 && !verified) {
    attempts += 1;
    let code = '';
    let send = '';

    do {
      send = String(await askQuestion(`[User ${userIndex}] Resend OTP? (true to resend, enter to ready to input otp): `)).trim();

      if (send === 'true') {
        const resendRes = await postJson(SERVER_URL, {
          query: resendOtpMutation,
          variables: {
            payload: {
              "send": true,
              "identifier": identifier,
            },
          },
        });

        console.log(`[User ${userIndex}] Resend OTP status:`, resendRes.status);
        console.log(`[User ${userIndex}] Resend OTP body:`, resendRes.body);
      } else {
        code = String(await askQuestion(`[User ${userIndex}] Enter OTP (attempt ${attempts}/2): `)).trim();
      }
    } while (send === 'true');

    const verifyRes = await postJson(SERVER_URL, {
      query: verifyMutation,
      variables: {
        payload: {
          "identifier": identifier,
          "otp": code,
        },
      },
    });

    console.log(`[User ${userIndex}] Verify status:`, verifyRes.status);
    console.log(`[User ${userIndex}] Verify body:`, verifyRes.body);

    const verifyBody = JSON.parse(verifyRes.body);
    const resp = verifyBody?.data?.auth?.response;

    if (resp === 'success') {
      console.log(`[User ${userIndex}] OTP verified`);
      verified = true;
      break;
    }

    if (resp === 'verify code incorrect') {
      console.log(`[User ${userIndex}] Verification incorrect — you may retry once.`);
      if (attempts >= 2) {
        console.log(`[User ${userIndex}] Second attempt failed, exiting.`);
        return;
      }
    } else if (resp === 'fail') {
      console.log(`[User ${userIndex}] Verification failed and session cleaned up by server.`);
      return;
    } else {
      console.log(`[User ${userIndex}] Verification unexpected response: ${resp}`);
      return;
    }
  }
}

  const queryRes = await postJson(SERVER_URL, {
    query: combinedQuery,
    variables: { "identifier": identifier },
  });

  console.log(`[User ${userIndex}] Query status:`, queryRes.status);
  console.log(`[User ${userIndex}] Query body:`, queryRes.body);

  console.log(`=== User ${userIndex} END ===`);
}

async function runConcurrent() {
  console.log('\nStarting concurrent users...\n');

  await Promise.all([
    runUser(1),
  ]);

  console.log('\n All users finished');
}

function askQuestion(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(q, (ans) => {
      rl.close();
      res(ans);
    });
  });
}

runConcurrent().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});