import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

const POLL_INTERVAL_MS = 8_000;
const CATALOG_RESCAN_MS = 6 * 60 * 60 * 1_000;
const SOURCE_PAUSE_MS = 350;
const MAX_ATTEMPTS = 5;
const WORKER_LOCK_ID = 4_209_261;

type AutomationPhase =
  | "disabled"
  | "starting"
  | "scanning"
  | "uploading"
  | "idle"
  | "error";

interface AutomationSnapshot {
  enabled: boolean;
  phase: AutomationPhase;
  currentSeriesTitle: string | null;
  currentSeason: string | null;
  currentEpisode: number | null;
  lastScanAt: string | null;
  lastError: string | null;
}

interface CatalogPage {
  items: { title: string; url: string }[];
  page: number;
  hasMore: boolean;
}

interface SeasonList {
  seasons: { season: string; episodeUrl: string }[];
}

interface ExtractedEpisodes {
  title: string;
  slug: string;
  season: string;
  episodes: { num: number; token: string; tokenType: string }[];
  episodeUrl: string;
}

interface EmbedResponse {
  videoUrl?: string;
  m3u8Url?: string;
  videoType?: "hls" | "mp4";
  subtitleUrl?: string | null;
}

interface CloudflareStreamItem {
  uid: string;
  meta?: { name?: string; automationKey?: string };
  playback?: { hls?: string };
}

interface QueueItem {
  id: number;
  episode_key: string;
  slug: string;
  series_title: string;
  season: string;
  episode_num: number;
  episode_url: string;
  attempts: number;
}

const snapshot: AutomationSnapshot = {
  enabled: process.env.DRAMA_AUTOMATION_ENABLED === "true",
  phase:
    process.env.DRAMA_AUTOMATION_ENABLED === "true" ? "starting" : "disabled",
  currentSeriesTitle: null,
  currentSeason: null,
  currentEpisode: null,
  lastScanAt: null,
  lastError: null,
};

let stopped = false;
let loopStarted = false;
let scanPage = 1;
let scanComplete = false;
let lastScanCompletedAt = 0;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localDramaApi(): string {
  const port = process.env.PORT;
  if (!port) throw new Error("API PORT is missing");
  return `http://127.0.0.1:${port}/api/drama`;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`API returned HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function fetchCatalogPage(page: number): Promise<CatalogPage> {
  const url = new URL(`${localDramaApi()}/catalog`);
  url.searchParams.set("page", String(page));
  return getJson<CatalogPage>(url.toString());
}

async function queueSeriesSeason(
  title: string,
  seriesSlug: string,
  seasonUrl: string,
): Promise<void> {
  const extractUrl = new URL(`${localDramaApi()}/extract`);
  extractUrl.searchParams.set("url", seasonUrl);
  const extracted = await getJson<ExtractedEpisodes>(extractUrl.toString());
  const season = extracted.season || "1";
  const episodeUrl = extracted.episodeUrl || seasonUrl;

  for (const episode of extracted.episodes) {
    const episodeKey =
      `${seriesSlug}:s${season}:e${episode.num}`.toLocaleLowerCase("en-US");
    await pool.query(
      `INSERT INTO drama_automation_episodes
        (episode_key, slug, series_title, season, episode_num, episode_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (episode_key) DO NOTHING`,
      [episodeKey, seriesSlug, title || extracted.title, season, episode.num, episodeUrl],
    );
  }
}

async function scanOneCatalogPage(): Promise<void> {
  snapshot.phase = "scanning";
  const catalog = await fetchCatalogPage(scanPage);

  for (const series of catalog.items) {
    const seasonsUrl = new URL(`${localDramaApi()}/seasons`);
    seasonsUrl.searchParams.set("url", series.url);
    const seasonList = await getJson<SeasonList>(seasonsUrl.toString());
    const slug = new URL(series.url).pathname.split("/").filter(Boolean).at(-1);
    if (!slug) continue;

    for (const season of seasonList.seasons) {
      await queueSeriesSeason(series.title, slug, season.episodeUrl);
      await wait(SOURCE_PAUSE_MS);
    }
  }

  if (catalog.hasMore && scanPage < 500) {
    scanPage += 1;
  } else {
    scanPage = 1;
    scanComplete = true;
    lastScanCompletedAt = Date.now();
    snapshot.lastScanAt = new Date(lastScanCompletedAt).toISOString();
    logger.info({ pagesScanned: catalog.page }, "Drama catalog scan completed");
  }
}

function cfAssetName(item: QueueItem): string {
  const episode = String(item.episode_num).padStart(2, "0");
  return `${item.slug}_S${item.season}E${episode}`;
}

async function findExistingCfVideo(
  accountId: string,
  token: string,
  name: string,
  episodeKey: string,
): Promise<CloudflareStreamItem | null> {
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`,
  );
  url.searchParams.set("search", name);
  url.searchParams.set("per_page", "1000");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare duplicate check failed (HTTP ${response.status})`);
  }
  const body = (await response.json()) as {
    success: boolean;
    result?: CloudflareStreamItem[];
  };
  if (!body.success) throw new Error("Cloudflare duplicate check failed");
  return (
    body.result?.find(
      (video) =>
        video.meta?.automationKey === episodeKey || video.meta?.name === name,
    ) ?? null
  );
}

async function claimNextEpisode(): Promise<QueueItem | null> {
  const result = await pool.query<QueueItem>(
    `WITH next_episode AS (
       SELECT id
       FROM drama_automation_episodes
       WHERE (
           (status = 'pending' AND attempts < $1)
           OR (status = 'failed' AND next_attempt_at <= NOW())
         )
         AND next_attempt_at <= NOW()
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE drama_automation_episodes AS episode
     SET status = 'processing',
         attempts = CASE
           WHEN episode.status = 'failed' THEN 1
           ELSE episode.attempts + 1
         END,
         updated_at = NOW()
     FROM next_episode
     WHERE episode.id = next_episode.id
     RETURNING episode.id, episode.episode_key, episode.slug,
       episode.series_title, episode.season, episode.episode_num,
       episode.episode_url, episode.attempts`,
    [MAX_ATTEMPTS],
  );
  return result.rows[0] ?? null;
}

async function markEpisodeDone(
  item: QueueItem,
  uid: string,
  hlsUrl: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE drama_automation_episodes
     SET status = 'done', cf_stream_uid = $2, cf_stream_url = $3,
         last_error = NULL, updated_at = NOW()
     WHERE id = $1`,
    [item.id, uid, hlsUrl],
  );
}

async function uploadEpisode(item: QueueItem): Promise<void> {
  snapshot.phase = "uploading";
  snapshot.currentSeriesTitle = item.series_title;
  snapshot.currentSeason = item.season;
  snapshot.currentEpisode = item.episode_num;

  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_STREAM_TOKEN;
  if (!accountId || !token) {
    throw new Error("Cloudflare Stream credentials are not configured");
  }

  const assetName = cfAssetName(item);
  const existing = await findExistingCfVideo(
    accountId,
    token,
    assetName,
    item.episode_key,
  );
  if (existing) {
    await markEpisodeDone(item, existing.uid, existing.playback?.hls ?? null);
    logger.info({ episodeKey: item.episode_key }, "Existing Stream video skipped");
    return;
  }

  const extractUrl = new URL(`${localDramaApi()}/extract`);
  extractUrl.searchParams.set("url", item.episode_url);
  const extracted = await getJson<ExtractedEpisodes>(extractUrl.toString());
  const episode = extracted.episodes.find(
    (candidate) => candidate.num === item.episode_num,
  );
  if (!episode) throw new Error("Episode no longer exists in the source catalog");

  const embedUrl = new URL(`${localDramaApi()}/embed`);
  embedUrl.searchParams.set("token", episode.token);
  embedUrl.searchParams.set("tokenType", episode.tokenType);
  embedUrl.searchParams.set("episodeUrl", extracted.episodeUrl || item.episode_url);
  const embed = await getJson<EmbedResponse>(embedUrl.toString());
  const videoUrl = embed.videoUrl ?? embed.m3u8Url;
  if (!videoUrl) throw new Error("Video stream could not be resolved");

  const videoType = embed.videoType ?? (videoUrl.includes(".m3u8") ? "hls" : "mp4");
  const uploadResponse = await fetch(`${localDramaApi()}/cf-upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videoUrl,
      videoType,
      directSource: true,
      name: assetName,
      creator: item.series_title,
      episodeNum: item.episode_num,
      season: item.season,
      subtitleUrl: embed.subtitleUrl ?? undefined,
      automationKey: item.episode_key,
    }),
    signal: AbortSignal.timeout(30 * 60 * 1_000),
  });
  if (!uploadResponse.ok) {
    const data = (await uploadResponse.json().catch(() => ({}))) as {
      error?: string;
      errorCode?: string;
    };
    throw new Error(data.error ?? `Cloudflare upload failed (HTTP ${uploadResponse.status})`);
  }

  const uploaded = (await uploadResponse.json()) as {
    uid: string;
    hlsUrl?: string | null;
  };
  await markEpisodeDone(item, uploaded.uid, uploaded.hlsUrl ?? null);
  logger.info({ episodeKey: item.episode_key }, "Episode uploaded to Stream");
}

async function processNextEpisode(): Promise<boolean> {
  const item = await claimNextEpisode();
  if (!item) return false;

  try {
    await uploadEpisode(item);
    snapshot.lastError = null;
  } catch (error) {
    const message =
      error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, "[source URL]") : "Upload failed";
    const delayMs = Math.min(60 * 60 * 1_000, 30_000 * 2 ** (item.attempts - 1));
    await pool.query(
      `UPDATE drama_automation_episodes
       SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END,
           next_attempt_at = NOW() + ($3 * INTERVAL '1 millisecond'),
           last_error = $4, updated_at = NOW()
       WHERE id = $1`,
      [item.id, MAX_ATTEMPTS, delayMs, message.slice(0, 500)],
    );
    snapshot.lastError = message.slice(0, 240);
    logger.error(
      { episodeKey: item.episode_key, attempt: item.attempts },
      "Automatic episode upload failed",
    );
  } finally {
    snapshot.currentSeriesTitle = null;
    snapshot.currentSeason = null;
    snapshot.currentEpisode = null;
  }
  return true;
}

async function runLoop(): Promise<void> {
  while (!stopped) {
    try {
      const scanDue =
        !scanComplete || Date.now() - lastScanCompletedAt >= CATALOG_RESCAN_MS;
      if (scanDue) await scanOneCatalogPage();

      const didUpload = await processNextEpisode();
      if (!didUpload && scanComplete) snapshot.phase = "idle";
      if (!didUpload) await wait(POLL_INTERVAL_MS);
      else await wait(POLL_INTERVAL_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Automation worker failed";
      snapshot.phase = "error";
      snapshot.lastError = message.replace(/https?:\/\/\S+/g, "[source URL]").slice(0, 240);
      logger.error({ message: snapshot.lastError }, "Drama automation loop failed");
      await wait(60_000);
    }
  }
}

export async function startDramaAutomation(): Promise<void> {
  if (loopStarted || process.env.DRAMA_AUTOMATION_ENABLED !== "true") return;
  stopped = false;

  const lockClient = await pool.connect();
  let lockAcquired = false;
  try {
    const lock = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [WORKER_LOCK_ID],
    );
    if (!lock.rows[0]?.locked) {
      lockClient.release();
      snapshot.phase = "idle";
      logger.info("Drama automation is already running in another API instance");
      return;
    }
    lockAcquired = true;

    await pool.query(
      `UPDATE drama_automation_episodes
       SET status = 'pending', updated_at = NOW()
       WHERE status = 'processing'`,
    );
  } catch (error) {
    if (lockAcquired) {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [WORKER_LOCK_ID]).catch(() => {});
    }
    lockClient.release();
    throw error;
  }

  loopStarted = true;
  snapshot.enabled = true;
  snapshot.phase = "starting";
  logger.info("Drama automation worker started");

  process.once("SIGTERM", () => {
    stopped = true;
    void lockClient.query("SELECT pg_advisory_unlock($1)", [WORKER_LOCK_ID])
      .finally(() => lockClient.release());
  });
  process.once("SIGINT", () => {
    stopped = true;
    void lockClient.query("SELECT pg_advisory_unlock($1)", [WORKER_LOCK_ID])
      .finally(() => lockClient.release());
  });

  void runLoop().finally(() => {
    snapshot.phase = "disabled";
    void lockClient.query("SELECT pg_advisory_unlock($1)", [WORKER_LOCK_ID])
      .finally(() => lockClient.release());
  });
}

export async function getDramaAutomationStatus() {
  const result = await pool.query<{ status: string; count: number }>(
    `SELECT status, COUNT(*)::int AS count
     FROM drama_automation_episodes
     GROUP BY status`,
  );
  const counts = { pending: 0, processing: 0, done: 0, failed: 0 };
  for (const row of result.rows) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] = row.count;
    }
  }
  return {
    ...snapshot,
    ...counts,
  };
}
