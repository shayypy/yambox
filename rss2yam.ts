import Parser from "rss-parser";
import { csvKeys, type CsvKey } from "./csv";

const LETTERBOXD_BASE = "https://letterboxd.com";
const botUserAgent = "yambox/1.0.0";

type CustomItem = {
  "letterboxd:watchedDate": string;
  "letterboxd:rewatch": string;
  "letterboxd:filmTitle": string;
  "letterboxd:filmYear": string;
  "letterboxd:memberRating"?: string;
  "tmdb:movieId"?: string;
  "tmdb:tvId"?: string;
};

const parser = new Parser<unknown, CustomItem>({
  customFields: {
    item: [
      "letterboxd:watchedDate",
      "letterboxd:rewatch",
      "letterboxd:filmTitle",
      "letterboxd:filmYear",
      "letterboxd:memberRating",
      "tmdb:movieId",
      "tmdb:tvId",
    ],
  },
  headers: { "User-Agent": botUserAgent },
});

interface DiaryFilm {
  username: string;
  slug: string;
  tmdb: number;
  tmdbType: "movie" | "tv";
  rating?: number;
  date: string;
  title: string;
  image?: string;
  snippet?: string;
}

const fetchDiary = async (username: string) => {
  console.log(`Loading diary for ${username}`);
  const feed = await parser.parseURL(`${LETTERBOXD_BASE}/${username}/rss/`);

  const diary: DiaryFilm[] = [];
  for (const item of feed.items) {
    let tmdbId: number;
    let tmdbType: DiaryFilm["tmdbType"] = "movie";
    if (item["tmdb:movieId"]) {
      tmdbId = Number(item["tmdb:movieId"]);
    } else if (item["tmdb:tvId"]) {
      tmdbId = Number(item["tmdb:tvId"]);
      tmdbType = "tv";
    } else {
      console.log("Missing TMDB identifier");
      continue;
    }

    const slug = item.link
      ? // 5 || 4 in case the username is removed from future links
        `film/${item.link.split("/")[5] || item.link.split("/")[4]}`
      : `tmdb/${tmdbId}`;

    const POSTER_RE = /https:\/\/a\.ltrbxd\.com\/.+\.(?:jpe?g|png)(?:\?v=\w+)?/;
    const posterMatch = item.content?.match(POSTER_RE);

    const rating = Number(item["letterboxd:memberRating"]);
    const filmItem: DiaryFilm = {
      username,
      slug,
      tmdb: tmdbId,
      tmdbType,
      rating: !rating || Number.isNaN(rating) ? undefined : rating * 2,
      date: item.isoDate ?? item["letterboxd:watchedDate"],
      title: item["letterboxd:filmTitle"],
      image: posterMatch?.[0],
      snippet: item.contentSnippet?.startsWith("Watched on ")
        ? undefined
        : item.contentSnippet,
    };
    diary.push(filmItem);
  }
  return diary;
};

const writeCsv = async (items: DiaryFilm[]) => {
  const lines: string[] = [csvKeys.map((k) => `"${k}"`).join(",")];
  const addLine = (line: Partial<Record<CsvKey, string>>) => {
    lines.push(
      csvKeys
        .map((key) => {
          const value = line[key] ?? "";
          return `"${value.replace(/(")/g, "\\$1")}"`;
        })
        .join(","),
    );
  };
  for (const item of items) {
    addLine({
      media_id: String(item.tmdb),
      source: "tmdb",
      media_type: item.tmdbType,
      title: item.title,
      image: item.image,
      score: item.rating ? `${item.rating}.0` : "",
      status: item.tmdbType === "tv" ? "In progress" : "Completed",
      notes: `${LETTERBOXD_BASE}/${item.slug}\\n${item.snippet}`
        .trim()
        .replace(/\\n$/, ""),
      start_date: item.date,
      end_date: item.tmdbType === "tv" ? undefined : item.date,
      created_at: item.date,
      progressed_at: item.date,
      progress: "0",
    });
  }

  Bun.write("diary.csv", lines.join("\n"));
};

(async () => {
  const usernames = process.argv.slice(2);
  if (!usernames) {
    throw Error(
      "Must provide letterboxd usernames to command, space-separated",
    );
  }

  const allEntries = (await Promise.all(usernames.map(fetchDiary))).flat();

  const entries: DiaryFilm[] = [];
  const processedSlugs: string[] = [];
  // Not a very efficient way to do this, but there aren't many entries per rss feed
  for (const entry of allEntries) {
    if (processedSlugs.includes(entry.slug)) continue;
    const items = allEntries.filter((e) => e.slug === entry.slug);
    if (items.length !== usernames.length) {
      console.log(
        `${items.length}/${usernames.length} entries for ${entry.slug}; skipping`,
      );
      continue;
    }

    const highestRating = items.sort(
      (a, b) => (b.rating ?? 0) - (a.rating ?? 0),
    )[0].rating;
    const newestDate = items.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    )[0].date;
    const newEntry: DiaryFilm = {
      ...entry,
      date: newestDate,
      rating: highestRating,
      snippet: items
        .filter((e) => !!e.snippet)
        .map((e) => {
          // We can't form a user activity URL for this film
          // if (e.slug.startsWith("tmdb/")) {
          return `${e.username}: ${e.snippet?.replace(/\n/g, "\\n")}`;
          // }
          // return `${LETTERBOXD_BASE}/${e.username}/${e.slug}\n${e.snippet}`;
        })
        .join("\\n\\n"),
    };
    processedSlugs.push(entry.slug);
    entries.push(newEntry);
  }

  await writeCsv(entries);
  console.log(`Wrote ${entries.length} films to diary.csv`);
})();
