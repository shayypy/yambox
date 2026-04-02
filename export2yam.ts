import { parse as parseCsv } from "csv-parse/sync";
import { csvKeys, type CsvKey } from "./csv";

const RESOLVE_URIS = Bun.env.RESOLVE_URIS !== "false";

const uriCache: Record<string, { type: string; id: number }> = {};
const uriFile = Bun.file("uris.txt");
if (RESOLVE_URIS) {
  try {
    const text = await uriFile.text();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const [uri, id, type] = line.split(" ");
      uriCache[uri] = { id: Number(id), type };
    }
  } catch {
    console.error("Failed to open uris.txt, probably does not exist");
  }
}
const uriWriter = uriFile.writer();

export const writeCsv = async (items: CombinationEntry[]) => {
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
      media_id: item.tmdb?.id?.toString(),
      source: "tmdb",
      media_type: item.tmdb?.type ?? "movie",
      title: item.name,
      score: item.rating ? `${item.rating * 2}.0` : undefined,
      status: item.tmdb?.type === "tv" ? "In progress" : "Completed",
      notes: item.note,
      start_date: item.dateWatched,
      end_date: item.dateWatched ?? item.dateAdded,
      created_at: item.dateAdded,
      progressed_at: item.dateWatched ?? item.dateAdded,
      progress: "0",
    });
  }

  Bun.write("output.csv", lines.join("\n"));
};

const readCsv = async <T>(filename: string): Promise<T[]> => {
  const text = await Bun.file(filename).text();
  const csv = parseCsv(text, {
    columns: true,
    skip_empty_lines: true,
  });
  return csv as T[];
};

interface ProfileFile {
  "Date Joined": string;
  Username: string;
  "Given Name": string;
  "Family Name": string;
  "Email Address": string;
  Location: string;
  Website: string;
  Bio: string;
  Pronoun: string;
  "Favorite Films": string;
}

interface DiaryFile {
  Date: string;
  Name: string;
  Year: string;
  "Letterboxd URI": string;
  Rating: string;
  Rewatch: "Yes" | "";
  Tags: string;
  "Watched Date": string;
}

interface WatchedFile {
  Date: string;
  Name: string;
  Year: string;
  "Letterboxd URI": string;
}

interface ReviewFile {
  Date: string;
  Name: string;
  Year: string;
  "Letterboxd URI": string;
  Rating: string;
  Rewatch: string;
  Review: string;
  Tags: string;
  "Watched Date": string;
}

interface CombinationEntry {
  username: string;
  tmdb?: { type: string; id: number };
  name: string;
  year: string;
  dateAdded: string;
  dateWatched?: string;
  uri: string;
  diary?: { uri: string; review?: string }[];
  rating?: number;
  // added by post-parse compilation logic
  note?: string;
}

const parseExport = async (directory: string) => {
  const [profile] = await readCsv<ProfileFile>(`${directory}/profile.csv`);
  const username = profile.Username;
  console.log(`[${username}] Parsing export`);

  const entries: CombinationEntry[] = [];
  const watched = await readCsv<WatchedFile>(`${directory}/watched.csv`);
  const diary = await readCsv<DiaryFile>(`${directory}/diary.csv`);
  const reviews = await readCsv<ReviewFile>(`${directory}/reviews.csv`);
  for (const entry of watched) {
    const diaries = diary
      .filter((d) => d.Name === entry.Name && d.Year === entry.Year)
      .sort((a, b) => {
        if (a.Date === b.Date) return -1;
        return 1;
      });

    const latestEntry = [...diaries].sort(
      (a, b) =>
        new Date(b["Watched Date"]).getTime() -
        new Date(a["Watched Date"]).getTime(),
    )[0];

    let tmdb: { type: string; id: number } | undefined;
    if (RESOLVE_URIS) {
      const lbUri = entry["Letterboxd URI"];
      const cached = uriCache[lbUri];
      if (cached) tmdb = cached;
      else {
        const response = await fetch(lbUri, {
          method: "GET",
          redirect: "follow",
        });
        if (response.ok) {
          const html = await response.text();
          const matches = html.matchAll(
            /(?:data-tmdb-(type)="(movie|tv)"|data-tmdb-(id)="(\d+)")/g,
          );
          let type: string | undefined;
          let id: number | undefined;
          for (const match of matches) {
            if (match[1] === "type") {
              type = match[2];
            }
            if (match[3] === "id") {
              id = Number(match[4]);
            }
          }
          if (type && id) {
            tmdb = { type, id };
            console.log(`[${username}] ${lbUri} = ${type}/${id}`);
            uriCache[lbUri] = tmdb;
            uriWriter.write(`${lbUri} ${id} ${type}\n`);
          }
        } else if (response.status >= 400 && response.status !== 404) {
          console.error(
            `HTTP ${response.status} while resolving ${response.url} - sleeping 10s`,
          );
          await Bun.sleep(10000);
        }
      }
    }

    entries.push({
      username,
      tmdb,
      name: entry.Name,
      dateAdded: diaries[0]?.Date ?? entry.Date,
      dateWatched: diaries[0]?.["Watched Date"],
      diary: diaries.map((d) => {
        const review = reviews.find(
          (r) => r["Letterboxd URI"] === d["Letterboxd URI"],
        );
        return { uri: d["Letterboxd URI"], review: review?.Review };
      }),
      rating: latestEntry?.Rating ? Number(latestEntry.Rating) : undefined,
      uri: entry["Letterboxd URI"],
      year: entry.Year,
    });
  }
  return entries;
};

(async () => {
  const folders = process.argv.slice(2);
  if (folders.length === 0) {
    throw Error(
      "Must provide letterboxd export directory names, space-separated, to this command",
    );
  }

  const allExports = (await Promise.all(folders.map(parseExport))).flat();
  uriWriter.end();

  const entries: CombinationEntry[] = [];
  const processedUris: string[] = [];
  // Not a very efficient way to do this
  for (const entry of allExports) {
    if (processedUris.includes(entry.uri)) continue;
    const items = allExports.filter((e) => e.uri === entry.uri);
    if (items.length !== folders.length) {
      console.log(
        `${items.length}/${folders.length} entries for ${entry.name}; skipping`,
      );
      continue;
    }

    const highestRating = items.sort(
      (a, b) => (b.rating ?? 0) - (a.rating ?? 0),
    )[0].rating;
    // I want to add multiple items for each diary entry but if you have a duplicate in the CSV file, the import fails
    const newestDate = items.sort(
      (a, b) =>
        new Date(b.dateAdded).getTime() - new Date(a.dateAdded).getTime(),
    )[0].dateAdded;
    const newEntry: CombinationEntry = {
      ...entry,
      dateAdded: newestDate,
      rating: highestRating,
      note: `${entry.uri}\n${items
        .flatMap(
          (item) =>
            item.diary?.map((d) =>
              `${item.username}: ${d.uri}\n${d.review ?? ""}`.trim(),
            ) ?? [],
        )
        .join("\n\n")
        .trim()}`,
    };
    processedUris.push(entry.uri);
    entries.push(newEntry);
  }

  await writeCsv(entries);
  console.log(`Wrote ${entries.length} films to output.csv`);
})();
