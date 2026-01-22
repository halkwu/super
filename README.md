# Australian & Cbus Super Integration

  **Overview**
  - This workspace contains integration scripts and GraphQL helpers for Australian Super and Cbus Super flows. It includes TypeScript API entrypoints, automation scripts, test helpers, and a bundled `k6` binary for load testing.

  **Repository layout**
  - `aus_test_1.js`, `aus_test_2.js` — quick JS test scripts
  - `k6_test.js` — k6 load/integration script
  - `schema.graphql` — shared GraphQL schema reference
  - `australian_super/`
    - `aus_api.ts` — GraphQL / API entry for Australian Super
    - `aus_super.ts` — automation / scraping logic
    - `launch_chrome.ts` — browser-launch helper
    - `package.json`, `tsconfig.json` — local config
  - `cbus_super/`
    - `cbus_api.ts`, `cbus.ts`, `package.json`, `tsconfig.json`

  **Prerequisites**
  - Node.js (recommended Node 16+) and npm
  - `ts-node` (used for dev runs) or a TypeScript build step
  - Browser automation may require Playwright or Puppeteer dependencies

  **Install dependencies**
  Install per-submodule to keep installs scoped:

  ```bash
  cd australian_super
  npm install

  cd ..\cbus_super
  npm install
  ```

  **Run Australian Super (dev)**

  ```bash
  cd australian_super
  npx ts-node aus_api.ts
  ```

  Or build then run:

  ```bash
  cd australian_super
  npm run build   # if defined
  node dist/aus_api.js
  ```

  **Run Cbus Super (dev)**

  ```bash
  cd cbus_super
  npx ts-node cbus_api.ts
  ```

  **GraphQL usage**
  - Servers typically expose a GraphQL endpoint (e.g. `http://localhost:4000/graphql`). Check the `*_api.ts` files for exact port and schema.

  Example auth mutation (adapt to your schema):

  ```graphql
  mutation Auth($payload: JSON) {
    auth(payload: $payload) {
      response
      identifier
    }
  }
  ```

  Example account/transactions query:

  ```graphql
  query GetBalanceAndTxs($identifier: String) {
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
  ```

  **k6 Load / Integration Testing for cbus**
  Run the bundled k6 to exercise `k6_test.js`:

  ```bash
  k6\k6-v1.5.0-windows-amd64\k6.exe run .\k6_test.js
  ```

  **quick JS test scripts Testing for aus**
  Run the bundled k6 to exercise `aus_test_1.js` and `aus_test_2.js`:

  ```bash
  node aus_test_1.js      
  node aus_test_2.js      
  ```
