# yambox

Tools for importing Letterboxd data to [Yamtrack](https://github.com/FuzzyGrim/Yamtrack).

# Run

1. Clone this repository
2. [Install Bun](https://bun.com)
3. Install dependencies:

```bash
bun install
```

## export2yam

1. Export your Letterboxd data from https://letterboxd.com/settings/data/
2. Unzip the file and place its contents in a new folder within this directory.
  - E.g. If you have cloned this repo to `~/yambox`, your diary.csv file should be at `~/yambox/myexportfoldername/diary.csv`, then you will pass `myexportfoldername` to the script. Unzip tools will typically do this for you when you select "unzip all"
3. Define environment variables (optional)
  - Create a `.env` file. Currently, one value is supported, `RESOLVE_URIS`, which can be set to `false`. [Read more about this option](#uri-caching)
4. Run the script with the export folder.
  - You can pass multiple export folders, and the tool will "merge" them in the output file. This is useful if you would like to use a single Yamtrack server for two or more people's shared watch history.

```bash
bun export2yam.ts letterboxd-firstusername-2026-01-01-00-00-utc letterboxd-secondusername-2026-01-01-00-00-utc
```

Writes `output.csv` in to the working directory in [Yamtrack's CSV import format](https://github.com/FuzzyGrim/Yamtrack/wiki/Media-Import-Configuration#yamtrack-csv-format). Import this file in Yamtrack settings -> Import data.

### URI Caching

By default, this tool will scrape each Letterboxd URI in your export in order to find which [TMDB](https://www.themoviedb.org) ID it refers to (and which type it is, since some films on Letterboxd are actually miniseries and have the `tv` type on TMDB). This is useful because it eliminates the guesswork otherwise done by Yamtrack to match each entry to a film or show. However, this process can take a long time. You can disable it by defining the `RESOLVE_URIS` environment variable as `false`.

Resolved URIs are written to `uris.txt` in the working directory.

## rss2yam

This tool is less sophisticated than export2yam in that it only works with the last 40-or-so diary entries available in your diary RSS feed. I wrote it thinking Yamtrack would deduplicate based on date, but it does not seem to.

There are no options. Simply run the script with one or multiple Letterboxd usernames (using multiple will "merge" the feeds and remove any entries that are not present in all diaries):

```bash
bun rss2yam.ts firstusername secondusername
```

Writes `diary.csv` in to the working directory in [Yamtrack's CSV import format](https://github.com/FuzzyGrim/Yamtrack/wiki/Media-Import-Configuration#yamtrack-csv-format). Import this file in Yamtrack settings -> Import data.

