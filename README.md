# Progress Partners Risk — VAMP Monitor

Next.js dashboard tracking Visa Acquirer Monitoring Program (VAMP) metrics
across all Stripe accounts, per statement descriptor.

## How it works

- **Daily cron** (`vercel.json`, 07:00 UTC = 10:00 Bucharest): `/api/cron/refresh`
  pulls from every Stripe account for the **current month to date**:
  - Charges (succeeded, Visa only) → sales count / volume per descriptor
  - Disputes (Visa only, all reasons)
  - Radar Early Fraud Warnings (TC40s, Visa only)
  - **VAMP count** = unique charges with an EFW or a dispute (deduped)
  - **VAMP ratio** = VAMP count / sales count
- Snapshot is written to **Vercel Blob** (`vamp/latest.json`).
- `/api/vamp` serves the snapshot to the dashboard.

No n8n, no Supabase.

## Setup (Vercel)

1. Import the repo into Vercel.
2. **Storage → Create Blob store** and connect it to the project
   (injects `BLOB_READ_WRITE_TOKEN`).
3. Environment variables:
   - `STRIPE_ACCOUNTS` — JSON map `{"Account Name": "rk_live_...", ...}`.
     Keys need read access to Charges, Disputes, Radar Early Fraud Warnings.
   - `CRON_SECRET` — any random string; protects the refresh endpoint.
4. Deploy. Trigger the first snapshot manually:
   `https://<your-app>.vercel.app/api/cron/refresh?secret=<CRON_SECRET>`
   The response lists per-account errors (e.g. keys missing permissions).
5. The cron keeps it updated daily at 10:00 Bucharest (summer time).

## Local dev

```bash
cp .env.local.example .env.local   # fill in values
npm install && npm run dev
```
