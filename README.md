# Tension

A quiet, private weekly hard-set volume tracker built around the MEV / MAV / MRV framework.

**Live:** [tension.noor-rai-ca.workers.dev](https://tension.noor-rai-ca.workers.dev/)

![Tension dashboard screenshot placeholder](https://placehold.co/1200x760/0f1411/e8ece9?text=Tension+dashboard)

## What this is

Tension records weekly hard-set volume for each muscle and places that volume against minimum effective volume (MEV), maximum adaptive volume (MAV), and maximum recoverable volume (MRV). Sets close enough to failure contribute fractional volume according to the muscles an exercise trains; lower-stimulus work remains visible without distorting the useful total.

The app teaches while it records. Terms can be opened in context and brief lessons appear when a user’s own data makes an idea relevant: effort below the stimulus threshold, volume below MEV, or accumulating fatigue beyond MRV. The interface stays quiet until explanation is useful.

Training templates begin sessions, and each exercise can recall its previous performance at the moment a new set is logged. A private Cloudflare account syncs the complete record across browsers and devices. Password recovery uses a private, single-use recovery code issued at account creation and replaced after use.

## Data model

Signed-out state is stored locally under `tension.v1.state`. When a user creates an account or signs in, a Cloudflare Worker writes the complete private state document to D1 and restores it on another browser. Logged sets, custom exercises, workout templates, sessions, archived lessons, and the root state carry UUIDs and ISO timestamps. Account recovery codes are stored only as keyed hashes in D1.

## Local development

The production frontend is in `public/` and is served with the API Worker through Cloudflare Static Assets. For local cloud-sync development, apply `worker/schema.sql` to a local D1 database with Wrangler, place a local `SESSION_PEPPER` in an ignored `.dev.vars` file, then run `npx wrangler dev`. The browser interface remains vanilla HTML, CSS and JavaScript with no runtime dependencies.

## Roadmap

Future work is tracked in [GitHub issues](https://github.com/drnoorrai/strength-training/issues), including installability, recovery integrations, and mesocycle planning.

Released under the [MIT License](LICENSE).
