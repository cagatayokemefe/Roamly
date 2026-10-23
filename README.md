# Travellers Market

A peer-to-peer marketplace prototype: people who are already flying into Turkey carry personal items for buyers, and every request is checked against Turkey's €430 personal duty-free allowance.

> Prototype for planning purposes — no real payments, accounts or customs data are processed.

## Features

- **Explore trips** — upcoming flights into İstanbul, filterable by region or "this week", plus search by city, traveler or category.
- **List a trip** — departure city, date, how many items you'll carry and which categories.
- **Request an item** — live allowance check per trip: categories the traveler accepts, phones blocked (IMEI rules), and the €430 limit shared across all requests on that trip.
- **Escrow flow** — requests move from *awaiting traveler* → *in escrow* → *delivered*, with payment released when the buyer confirms.
- **Dashboard** — money in escrow / waiting / earned, your sent requests, and incoming requests on your own trips (accept or decline).
- **Disputes** — raise a dispute on an escrowed request and resolve it as the reviewer.

All data is saved in the browser's `localStorage`. Use **Reset demo data** in the footer to restore the sample trips.

## Run it

No build step or dependencies — it's plain HTML, CSS and JavaScript.

- **VS Code:** install the *Live Server* extension, right-click `index.html` → **Open with Live Server**.
- **Terminal:** `python3 -m http.server 5173`, then open http://localhost:5173.
- Or just open `index.html` in a browser.

## Files

| File | What it holds |
| --- | --- |
| `index.html` | Page layout and all views |
| `styles.css` | The "Nature Explorer" design: forest green, cream and sand |
| `app.js` | State, rendering and every flow (trips, requests, allowance, escrow, disputes) |
