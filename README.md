# dangent.uk

Games site on Cloudflare, deployed automatically from this repository: every push to `main` goes live within a minute or two.

- `public/` is the website. Each game has its own folder (`public/streaker/`).
- `src/worker.js` is the leaderboard API (`/api/board`, `/api/submit_score`). Scores are stored in the Cloudflare D1 database `dangent-scores`.
- `wrangler.jsonc` is the Cloudflare configuration.
- `tools/streaker/` holds Streaker's source: `template.html` (the game), `data.json` (the players) and `build.py`, which writes `public/streaker/index.html`.

To remove a leaderboard entry: Cloudflare dashboard > Storage & databases > D1 > dangent-scores > Console, then
`DELETE FROM scores WHERE id = 123;`
