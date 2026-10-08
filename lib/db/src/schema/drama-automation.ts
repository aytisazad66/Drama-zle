import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const dramaAutomationEpisodes = pgTable(
  "drama_automation_episodes",
  {
    id: serial("id").primaryKey(),
    episodeKey: text("episode_key").notNull(),
    slug: text("slug").notNull(),
    seriesTitle: text("series_title").notNull(),
    season: text("season").notNull(),
    episodeNum: integer("episode_num").notNull(),
    episodeUrl: text("episode_url").notNull(),
    status: text("status")
      .$type<"pending" | "processing" | "done" | "failed">()
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    cfStreamUid: text("cf_stream_uid"),
    cfStreamUrl: text("cf_stream_url"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("drama_automation_episode_key_uq").on(table.episodeKey),
    index("drama_automation_status_next_attempt_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
  ],
);

export type DramaAutomationEpisode =
  typeof dramaAutomationEpisodes.$inferSelect;
