# dangent.uk

Games site on Cloudflare, deployed automatically from this repository: every push to `main` goes live within a minute or two.

- `public/` is the website. Each game has its own folder (`public/streaker/`).
- `src/worker.js` is the leaderboard API (`/api/board`, `/api/submit_score`). Scores are stored in the Cloudflare D1 database `dangent-scores`.
- `wrangler.jsonc` is the Cloudflare configuration.
- `tools/streaker/` holds Streaker's source: `template.html` (the game), `data.json` (the players) and `build.py`, which writes `public/streaker/index.html`.
- `tools/five-a-sold/` holds Five-a-Sold's source: `template.html` (the page), `engine.js` (auction and match engine), `data.json` (players, managers, portraits and commentary) and `build.py`, which writes `public/five-a-sold/index.html`.

Usage counter: the pages send small anonymous events (view, start, auction_done, kickoff, finish) to `/api/event`, stored in the `events` table of `dangent-scores`. Nothing on the site reads them back; only the dashboard (D1 > dangent-scores > Console) or Claude can, e.g.
`SELECT game, event, count(*) FROM events GROUP BY game, event;`
Events are only sent from dangent.uk itself, so local copies and previews don't count.

To remove a leaderboard entry: Cloudflare dashboard > Storage & databases > D1 > dangent-scores > Console, then
`DELETE FROM scores WHERE id = 123;`
