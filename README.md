# dangent.uk

Games site, served by Cloudflare from this repository. Every push to `main` deploys automatically.

- `public/` is the website. Each game lives in its own folder (`public/streaker/`).
- `wrangler.jsonc` tells Cloudflare to serve `public/` as a static site.
