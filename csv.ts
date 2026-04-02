export const csvKeys = [
  "media_id",
  "source",
  "media_type",
  "title",
  "image",
  "season_number",
  "episode_number",
  "score",
  "status",
  "notes",
  "start_date",
  "end_date",
  "progress",
  "created_at",
  "progressed_at",
] as const;

export type CsvKey = (typeof csvKeys)[number];
