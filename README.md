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
- **Ratings** — after an on-chain deal ends, buyer and traveler rate each other (1–5 stars + a short comment). Ratings live in the contract, so they can't be faked, edited or deleted, and traveler profiles show the on-chain average.
- **Disputes** — on-chain, buyer and traveler each propose a split and the contract pays out when they match; demo requests are resolved by playing the reviewer.

- **Turkish and English** — a TR | EN switch in the header; the first visit follows the browser's language and the choice is remembered. Dates and numbers are formatted for the chosen language.

App data is saved in the browser's `localStorage`. Use **Reset demo data** in the footer to restore the sample trips.

## How the escrow contract works

[`contracts/RoamlyEscrow.sol`](contracts/RoamlyEscrow.sol) has **no owner, admin or arbiter** — nobody can move a deal's money except through these rules:

| Situation | What happens |
| --- | --- |
| Buyer sends a request | Payment + a 10% refundable deposit are locked in the contract |
| Traveler accepts | Traveler locks the same deposit |
| Traveler hasn't accepted yet | Buyer can cancel, or traveler can decline → full refund |
| Buyer confirms delivery | Traveler is paid, minus the 2% fee; both deposits are returned |
| Traveler enters the buyer's delivery code at handover | Same as confirming — traveler is paid at once |
| Traveler marks delivered, buyer stays silent 7 days | Anyone can release the payment to the traveler |
| Not delivered by trip date + 14 days | Buyer can reclaim the full amount **plus the traveler's deposit** |
| Buyer opens a dispute (before delivery, or within 7 days after) | Funds freeze; both sides propose how much goes back to the buyer — when the proposals match, it pays out |
| Dispute settled by agreement | Paid out as agreed; both deposits are returned |
| No agreement within 30 days | Anyone can settle it 50/50 — **the buyer's deposit goes to the traveler** |

- **Deposits:** 10% from each side, returned in every other case. They make stalling a dispute costly for the buyer and accepting without delivering costly for the traveler. Set at deploy time, capped at 30%.
- **Fee:** 2%, taken only from what the traveler receives. Refunds and deposits are never charged. It's fixed at deploy time and the contract refuses anything above 5%.
- **Delivery code:** when paying, the app creates a random 16-character code (80 bits) and only its hash goes into the contract. At handover the buyer checks the item and shows the code as a QR (or reads it out); the traveler scans or types it and the contract pays out straight away. It must be long because the hash is public. The code is kept only in the buyer's browser; "Confirm received" and the 7-day release still work without it.
- **Receipts:** the traveler can attach a photo of the shop receipt once, while the deal is running. The photo (shrunk to ~1024 px) stays in the browser; the contract stores its keccak256 fingerprint, the total in euros and the time, so nobody can swap the receipt later. The buyer is warned if the receipt total is above the agreed price, and the viewer checks the photo against the on-chain fingerprint.
- **Ratings:** once an accepted deal is paid out, refunded or split, each side can rate the other once — 1–5 stars and up to 140 characters. Requests that were never accepted can't be rated.
- **Currency:** USDT for now. The token is a deploy setting (`TOKEN_ADDRESS`), so it can be swapped without changing the contract.
- **Exchange rate:** prices are entered in euros and converted to USDT at payment time using the European Central Bank's daily EUR/USD rate (via [Frankfurter](https://frankfurter.dev)), counting 1 USDT as 1 USD. If the rate can't be loaded, the last saved rate is used; with none saved, a 1.08 estimate is shown with a warning. The rate used is stored with each request. The contract itself only sees USDT amounts.

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
| `i18n.js` | All interface text in English and Turkish, and the language switch |
| `chain.js` | MetaMask connection and calls to the escrow contract |
| `contracts/RoamlyEscrow.sol` | The escrow smart contract |
| `contracts/TestUSDT.sol` | Free test token with a faucet, for testnets |
| `test/RoamlyEscrow.test.js` | Contract tests |
| `scripts/deploy.js` | Deploys the contracts and records their addresses |
| `deployments.js` | Contract addresses per network, read by the site |
