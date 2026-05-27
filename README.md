# Tension

A quiet weekly hard-set volume tracker built around the MEV / MAV / MRV framework.

**Live:** [drnoorrai.github.io/strength-training](https://drnoorrai.github.io/strength-training/)

![Tension dashboard screenshot placeholder](https://placehold.co/1200x760/0f1411/e8ece9?text=Tension+dashboard)

## What this is

Tension records weekly hard-set volume for each muscle and places that volume against minimum effective volume (MEV), maximum adaptive volume (MAV), and maximum recoverable volume (MRV). Sets close enough to failure contribute fractional volume according to the muscles an exercise trains; lower-stimulus work remains visible without distorting the useful total.

The app teaches while it records. Terms can be opened in context and brief lessons appear when a user’s own data makes an idea relevant: effort below the stimulus threshold, volume below MEV, or accumulating fatigue beyond MRV. The interface stays quiet until explanation is useful.

## Data model

All user data is stored locally under `tension.v1.state`. Logged sets, custom exercises, archived lessons, and the root state carry UUIDs and ISO timestamps; user-edited target ranges are stored separately from seeded defaults. This keeps a later move to synced records mechanical.

## Local development

Open `index.html` in a browser, or serve the repository root with any small static HTTP server. There is no build step and there are no dependencies.

## Roadmap

Future work is tracked in [GitHub issues](https://github.com/drnoorrai/strength-training/issues), including account sync, installability, recovery integrations, and mesocycle planning.

Released under the [MIT License](LICENSE).
