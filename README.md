# imdboxd

Automatically add new entries from your Letterboxd watchlist to your IMDb watchlist. Due to the limitations of partial data this does not attempt to remove items from IMDb that have been removed from the Letterboxd list. I rarely find myself removing items from my watchlist (without having watched them) so I just do that manually on both platforms when necessary.

The purpose of this application is to enable the use of external programs which rely on IMDb watchlists meanwhile you use Letterboxd as a source of truth.

I recommend setting up a cron job for 2-3 times a day depending on how often you typically update your watchlist.

# Dev

To install dependencies:

```bash
bun install
```

Create a `.env` file:

```
LETTERBOXD_USERNAME='kylemaclachlan_' # Your LB username (must have a public watchlist)
IMDB_COOKIES='...' # Your authenticated cookies on imdb.com
TMDB_KEY='...' # (optional) themoviedb.org API key for resolving diary TMDB IDs, faster than relying on LB
```

Create files named `watchlist.json` and `watched.json`, both with the same initial content:

```json
{"films": []}
```

To run:

```bash
bun run index.ts
```
