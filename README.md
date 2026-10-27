# Roamly

Roamly is a peer-to-peer marketplace prototype: people who are already flying into Turkey carry personal items for buyers, and every request is checked against Turkey's €430 personal duty-free allowance.

Payments can run through a **smart contract on BNB Smart Chain**: the buyer's money is locked in the `RoamlyEscrow` contract — not held by Roamly or the traveler — and released only by the rules written into the contract.

> Prototype — on-chain payments run on BNB Smart Chain **Testnet** with worthless test tokens. No real money, accounts or customs data are processed.

## Features

- **Explore trips** — upcoming flights into İstanbul, filterable by region or "this week", plus search by city, traveler or category.
- **List a trip** — departure city, date, how many items you'll carry and which categories. With a wallet connected, payouts go to that wallet.
- **Request an item** — live allowance check per trip: categories the traveler accepts, phones blocked (IMEI rules), and the €430 limit shared across all requests on that trip.
- **On-chain escrow** — on trips whose traveler linked a wallet, the request pays USDT into the escrow contract through MetaMask. Trips without a wallet run in demo escrow.
- **Dashboard** — money in escrow / waiting / earned, your sent requests, incoming requests on your own trips, and your wallet balance (with a test-USDT faucet on testnet).
- **Disputes** — on-chain, buyer and traveler each propose a split and the contract pays out when they match; demo requests are resolved by playing the reviewer.

App data is saved in the browser's `localStorage`. Use **Reset demo data** in the footer to restore the sample trips.

## How the escrow contract works

[`contracts/RoamlyEscrow.sol`](contracts/RoamlyEscrow.sol) has **no owner, admin or arbiter** — nobody can move a deal's money except through these rules:

| Situation | What happens |
| --- | --- |
| Buyer sends a request | Payment is locked in the contract |
| Traveler hasn't accepted yet | Buyer can cancel, or traveler can decline → full refund |
| Buyer confirms delivery | Traveler is paid, minus the 2% fee |
| Traveler marks delivered, buyer stays silent 7 days | Anyone can release the payment to the traveler |
| Not delivered by trip date + 14 days | Buyer can reclaim the full amount |
| Buyer opens a dispute (before delivery, or within 7 days after) | Funds freeze; both sides propose how much goes back to the buyer — when the proposals match, it pays out |
| No agreement within 30 days | Anyone can settle it 50/50 |

- **Fee:** 2%, taken only from what the traveler receives. Refunds are never charged. It's fixed at deploy time and the contract refuses anything above 5%.
- **Currency:** USDT for now. The token is a deploy setting (`TOKEN_ADDRESS`), so it can be swapped without changing the contract.

## Run it

The website itself has no build step — it's plain HTML, CSS and JavaScript.

- **VS Code:** install the *Live Server* extension, right-click `index.html` → **Open with Live Server**.
- **Terminal:** `python3 -m http.server 5173`, then open http://localhost:5173.

To use on-chain payments you also need [MetaMask](https://metamask.io/download/) in your browser.

## Contracts

```bash
npm install          # Hardhat + OpenZeppelin
npm test             # run the contract tests
```

**Try it on a local chain**

```bash
npm run chain          # terminal 1: local blockchain on http://127.0.0.1:8545
npm run deploy:local   # terminal 2: deploys Test USDT + escrow, writes deployments.local.js
```

Then add the network *Hardhat Local* (RPC `http://127.0.0.1:8545`, chain id `31337`) to MetaMask and import a couple of the test accounts printed by `npm run chain`.

**Deploy to BNB Smart Chain Testnet**

1. Create a **new** MetaMask account just for testing and get free tBNB from the [BNB testnet faucet](https://www.bnbchain.org/en/testnet-faucet).
2. `cp .env.example .env` and paste that account's private key into `PRIVATE_KEY`. `.env` is gitignored — never commit it or share it.
3. `npm run deploy:testnet` — deploys Test USDT and the escrow, and writes the addresses to `deployments.js` (commit that file so the site knows where the contract lives).

**Testing both sides:** list a trip with one MetaMask account, switch to a second account, then request an item on that trip. Switch back and forth to accept, mark delivered, confirm or dispute.

## Files

| File | What it holds |
| --- | --- |
| `index.html` | Page layout and all views |
| `styles.css` | The "Nature Explorer" design: forest green, cream and sand |
| `app.js` | State, rendering and every flow (trips, requests, allowance, escrow, disputes) |
| `chain.js` | MetaMask connection and calls to the escrow contract |
| `contracts/RoamlyEscrow.sol` | The escrow smart contract |
| `contracts/TestUSDT.sol` | Free test token with a faucet, for testnets |
| `test/RoamlyEscrow.test.js` | Contract tests |
| `scripts/deploy.js` | Deploys the contracts and records their addresses |
| `deployments.js` | Contract addresses per network, read by the site |
