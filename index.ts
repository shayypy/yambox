import puppeteer, { type Page, type Browser } from "puppeteer";
import Parser from "rss-parser";

type Env = NodeJS.ProcessEnv & {
  LETTERBOXD_USERNAME: string;
  IMDB_COOKIES: string;
  TMDB_KEY?: string;
};

const env = Bun.env as Env;

const LETTERBOXD_BASE = "https://letterboxd.com";
const IMDB_BASE = "https://www.imdb.com";
const IMDB_GRAPHQL = "https://api.graphql.imdb.com";
const userAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:136.0) Gecko/20100101 Firefox/136.0";
const botUserAgent = "imdboxd/1.0.0";

interface ListFilm {
  id: string;
  uid?: string;
  slug: string;
  name?: string;
  imdb?: string;
  tmdb?: number;
  cacheBustingKey?: string;
}

const graphqlRequest = async (payload: {
  operationName: string;
  query: string;
  variables?: unknown;
}): Promise<Response> => {
  return await fetch(IMDB_GRAPHQL, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      Accept: "application/graphql+json, application/json",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.5",
      Origin: IMDB_BASE,
      Referer: `${IMDB_BASE}/`,
      Cookie: env.IMDB_COOKIES,
      "User-Agent": userAgent,
      "content-type": "application/json",
      // "x-imdb-client-name": "imdb-web-next-localized",
    },
  });
};

const getExternalIds = async (page: Page, slug: string) => {
  await page.goto(`${LETTERBOXD_BASE}/film/${slug}`, {
    waitUntil: "domcontentloaded",
    timeout: 240_000,
  });
  return await page.evaluate(() => {
    let imdbId: string | undefined;
    let tmdbId: number | undefined;
    const imdbButton = document.querySelector<HTMLAnchorElement>(
      ".text-footer>a[data-track-action='IMDb']",
    );
    if (imdbButton?.href) {
      const match = /imdb\.com\/title\/(tt\d+)\//i.exec(imdbButton.href);
      if (match) imdbId = match[1];
    }
    const tmdbButton = document.querySelector<HTMLAnchorElement>(
      ".text-footer>a[data-track-action='TMDB']",
    );
    if (tmdbButton?.href) {
      // sometimes letterboxd has tv shows listed as movies and they link
      // the tmdb.org/tv url. we just ignore that for simplicity
      const match = /themoviedb\.org\/movie\/(\d+)\//i.exec(tmdbButton.href);
      if (match) tmdbId = Number(match[1]);
    }
    return { imdbId, tmdbId };
  });
};

const syncWatchlist = async (browser: Browser) => {
  const page = await browser.newPage();

  console.log(
    `Fetching watchlist for ${env.LETTERBOXD_USERNAME} (this might take a while)`,
  );
  await page.goto(`${LETTERBOXD_BASE}/${env.LETTERBOXD_USERNAME}/watchlist/`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });

  console.log("Evaluating watchlist");
  // Extract data
  const { films } = await page.evaluate(() => {
    const containers = Array.from(
      document.querySelectorAll<HTMLDivElement>("li.poster-container>div"),
    );
    const films: ListFilm[] = [];
    // const bad = [];
    for (const container of containers) {
      const name = container.querySelector("img")?.alt;
      const data: Partial<ListFilm> = {
        id: container.dataset.filmId,
        uid: container.dataset.itemUid,
        slug: container.dataset.filmSlug,
        name,
        cacheBustingKey: container.dataset.cacheBustingKey,
      };
      if (!data.id || !data.slug) {
        // bad.push(data)
        continue;
      }
      films.push(data as ListFilm);
    }
    return { films };
  });

  const extant = (await Bun.file("./watchlist.json").json()) as {
    films: ListFilm[];
  };
  const extantFilmIds = extant.films.map((f) => f.id);
  const newFilms = films.filter((f) => !extantFilmIds.includes(f.id));
  if (newFilms.length === 0) {
    console.log("Lists are synced!");
    return;
  }

  let imdbListId: string | undefined;
  for (const film of newFilms) {
    const { imdbId, tmdbId } = await getExternalIds(page, film.slug);
    if (imdbId) {
      console.log(`IMDb ID for ${film.slug}: ${imdbId}`);
      film.imdb = imdbId;
      film.tmdb = tmdbId;

      const response = await graphqlRequest({
        operationName: "AddIdToWatchlist",
        query:
          "mutation AddIdToWatchlist($id: ID!) {\n  addItemToPredefinedList(\n    input: {classType: WATCH_LIST, item: {itemElementId: $id}}\n  ) {\n    modifiedItem {\n      itemId\n    }\n  }\n}",
        variables: { id: imdbId },
      });
      if (!response.ok) {
        console.log(`Failed to add ${imdbId}`, response);
        if (response.status === 403) {
          break;
        }
      } else {
        console.log(`Added ${imdbId}`);
        if (!imdbListId) {
          const data = (await response.json()) as {
            // list_id: string;
            // list_item_id: string;
            // status: number;
            data: {
              addItemToPredefinedList: {
                modifiedItem: {
                  // client's watchlist ID
                  itemId: string;
                };
              };
            };
          };
          imdbListId = data.data.addItemToPredefinedList.modifiedItem.itemId;
        }
      }
    } else {
      console.log(`No IMDb ID for ${film.slug}`);
    }
    extant.films.push(film);
  }

  console.log("New films:", newFilms.length);
  if (imdbListId) {
    console.log(`IMDb watchlist: ${IMDB_BASE}/list/${imdbListId}/`);
  }
  await Bun.write("./watchlist.json", JSON.stringify(extant));
};

type CustomItem = {
  "letterboxd:watchedDate": string;
  "letterboxd:rewatch": string;
  "letterboxd:filmTitle": string;
  "letterboxd:filmYear": string;
  "letterboxd:memberRating"?: string;
  "tmdb:movieId"?: string;
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
    ],
  },
  headers: { "User-Agent": botUserAgent },
});

interface DiaryFilm {
  id: string;
  slug: string;
  imdb?: string;
  tmdb?: number;
  rating: number | null;
  updated: string;
}

const syncDiary = async (browser: Browser) => {
  const page = await browser.newPage();

  console.log("Loading diary & watchlist");
  const watched = (await Bun.file("./watched.json").json()) as {
    films: DiaryFilm[];
  };
  const watchlist = (await Bun.file("./watchlist.json").json()) as {
    films: ListFilm[];
  };

  console.log(`Fetching diary for ${env.LETTERBOXD_USERNAME}`);
  const feed = await parser.parseURL(
    `https://letterboxd.com/${env.LETTERBOXD_USERNAME}/rss/`,
  );

  const requests: {
    imdbId: string;
    rating: number | null;
  }[] = [];
  const mustFetch: {
    uid: string;
    id?: string;
    tmdbId?: number;
    rating: number | null;
  }[] = [];
  for (const item of feed.items) {
    // Chances are pretty slim `id` will ever be missing but we have backup just in case
    const id = item.guid?.replace(/^letterboxd-watch-/, "");
    const tmdbId = item["tmdb:movieId"]
      ? Number(item["tmdb:movieId"])
      : undefined;
    const uid = item.link
      ? // 5 || 4 in case the username is removed from future links
        item.link.split("/")[5] || item.link.split("/")[4]
      : id
        ? `film:${id}`
        : tmdbId
          ? `tmdb:${tmdbId}`
          : null;
    if (!uid) {
      console.log("Missing all identifiers");
      continue;
    }

    const watchlistFilm = watchlist.films.find(
      (f) => f.id === id || (tmdbId !== undefined && f.tmdb === tmdbId),
    );
    const watchedFilm = watched.films.find(
      (f) => f.id === id || (tmdbId !== undefined && f.tmdb === tmdbId),
    );
    const imdbId = watchlistFilm?.imdb;

    const rating = Number(item["letterboxd:memberRating"]);
    if (!rating || Number.isNaN(rating)) {
      if (!watchedFilm || watchedFilm.rating !== null) {
        // Just mark as watched
        console.log(`${item.title} (no rating)`);
        if (imdbId) {
          requests.push({ imdbId, rating: null });
        } else if (!watchlistFilm) {
          mustFetch.push({ id, uid, tmdbId, rating: null });
        }
      } else {
        console.log(
          `Already marked ${item["letterboxd:filmTitle"]} as watched`,
        );
      }
    } else {
      const imdbRating = rating * 2;
      if (!watchedFilm || watchedFilm.rating !== imdbRating) {
        console.log(`${item.title} (${imdbRating}/10)`);
        if (imdbId) {
          requests.push({ imdbId, rating: imdbRating });
        } else if (!watchlistFilm) {
          mustFetch.push({ id, uid, tmdbId, rating: imdbRating });
        }
      } else {
        console.log(
          `Already marked ${item["letterboxd:filmTitle"]} as ${imdbRating}/10`,
        );
      }
    }

    if (!watchedFilm) {
      const filmItem: DiaryFilm = {
        id: id ?? "",
        slug: uid,
        imdb: imdbId,
        tmdb: tmdbId,
        rating: !rating || Number.isNaN(rating) ? null : rating * 2,
        updated: item.isoDate ?? item["letterboxd:watchedDate"],
      };
      watched.films.push(filmItem);
    }
  }

  for (const film of mustFetch) {
    let imdbId: string | undefined;
    if (film.tmdbId && env.TMDB_KEY) {
      // Avoid letterboxd requests if possible
      const response = await fetch(
        `https://api.themoviedb.org/3/movie/${film.tmdbId}/external_ids`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${env.TMDB_KEY}`,
            Accept: "application/json",
            "User-Agent": botUserAgent,
          },
        },
      );
      if (response.ok) {
        const data = (await response.json()) as { imdb_id?: string };
        if (data.imdb_id) imdbId = data.imdb_id;
      }
    }
    if (!imdbId) {
      ({ imdbId } = await getExternalIds(page, film.uid));
    }
    if (imdbId) {
      requests.push({ imdbId, rating: film.rating });
      console.log(`Resolved IMDb ID for ${film.uid}: ${imdbId}`);
      if (film.id || film.tmdbId) {
        const watchedFilm = watched.films.find(
          (f) =>
            f.id === film.id ||
            (film.tmdbId !== undefined && f.tmdb === film.tmdbId),
        );
        if (watchedFilm) watchedFilm.imdb = imdbId;
      }
    }
  }
  for (const request of requests) {
    const response = await graphqlRequest(
      request.rating === null
        ? {
            operationName: "AddWatchedTitle",
            query:
              "mutation AddWatchedTitle($titleId: ID!) {\n  addWatchedTitle(titleId: $titleId) {\n    message {\n      language\n      value\n    }\n    success\n  }\n}",
            variables: { titleId: request.imdbId },
          }
        : {
            operationName: "UpdateTitleRating",
            query:
              "mutation UpdateTitleRating($rating: Int!, $titleId: ID!) {\n  rateTitle(input: {rating: $rating, titleId: $titleId}) {\n    rating {\n      value\n    }\n  }\n}",
            variables: { rating: request.rating, titleId: request.imdbId },
          },
    );
    if (response.ok) {
      console.log(
        `Marked ${request.imdbId} as watched (${request.rating ? `${request.rating}/10` : "no rating"})`,
      );
      // TODO: check if it's in the watchlist first
      const removeResponse = await graphqlRequest({
        operationName: "RemoveIdFromWatchlist",
        query:
          "mutation RemoveIdFromWatchlist($id: ID!) {\n  removeElementFromPredefinedList(\n    input: {classType: WATCH_LIST, itemElementId: $id}\n  ) {\n    modifiedItem {\n      itemId\n    }\n  }\n}",
        variables: { id: request.imdbId },
      });
      if (!removeResponse.ok) {
        console.log("Failed to remove it from watchlist", removeResponse);
        if (removeResponse.status === 403) break;
      }
    } else {
      console.log(`Failed to mark ${request.imdbId} as watched`, response);
    }
  }

  await Bun.write("./watched.json", JSON.stringify(watched));
  console.log("New ratings:", requests.length);
};

(async () => {
  const browser = await puppeteer.launch({
    // first request to letterboxd takes a really long time for some reason
    timeout: 240_000,
  });
  await syncWatchlist(browser);
  await syncDiary(browser);
  await browser.close();
})();
