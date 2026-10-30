# dangent.uk

Games site on Cloudflare, deployed automatically from this repository: every push to `main` goes live within a minute or two.

- `public/` is the website. Each game has its own folder (`public/streaker/`).
- `src/worker.js` is the leaderboard API (`/api/board`, `/api/submit_score`). Scores are stored in the Cloudflare D1 database `dangent-scores`.
- `wrangler.jsonc` is the Cloudflare configuration.
- `tools/streaker/` holds Streaker's source: `template.html` (the game), `data.json` (the players) and `build.py`, which writes `public/streaker/index.html`.
- `tools/five-a-sold/` holds Five-a-Sold's source: `template.html` (the page), `engine.js` (auction and match engine), `data.json` (players, managers, portraits and commentary) and `build.py`, which writes `public/five-a-sold/index.html`.

Usage counter: the pages send small anonymous events (view, start, auction_done, kickoff, finish) to `/api/event`, stored in the `events` table of `dangent-scores`. Nothing on the site reads them back; only the dashboard (D1 > dangent-scores > Console) or Claude can, e.g.
`SELECT game, event, count(*) FROM events GROUP BY game, event;`

Five-a-Sold global table: when a campaign ends, the page posts the season to `/api/season` and it is stored in the `seasons` table of `dangent-scores` (team name, W/D/L, goal difference, goals for and against where known, points, finishing position in that campaign, top scorer and goals). Each campaign has a random id, so a resend can't log it twice; a season finished offline is kept in the browser and sent the next time the page opens. `/api/seasons` returns the top 50 plus two either side of the player's own season, sorted on points, goal difference, then goals scored. Remove a row in the dashboard console, e.g. `DELETE FROM seasons WHERE id = 12;`

Campaign log: the same submission also stores the whole season as JSON in `campaign_log` (all 120 fixtures, final table, top 15 scorers, every club's squad with prices paid, opponent order). It is never read back by the site. Query it with `json_extract` in the D1 console, or ask Claude for the Excel workbook.
Events are only sent from dangent.uk itself, so local copies and previews don't count.

To remove a leaderboard entry: Cloudflare dashboard > Storage & databases > D1 > dangent-scores > Console, then
`DELETE FROM scores WHERE id = 123;`
