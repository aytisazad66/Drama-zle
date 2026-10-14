import {
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const dramaStreamUploads = pgTable(
  "drama_stream_uploads",
  {
    uid: text("uid").primaryKey(),
    slug: text("slug").notNull(),
    seriesTitle: text("series_title").notNull(),
    videoName: text("video_name").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("drama_stream_uploads_slug_uploaded_at_idx").on(
      table.slug,
      table.uploadedAt,
    ),
  ],
);

export type DramaStreamUpload = typeof dramaStreamUploads.$inferSelect;
