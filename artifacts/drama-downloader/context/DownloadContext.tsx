import React, {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import * as FileSystem from 'expo-file-system/legacy';

export type DownloadStatus =
  | 'queued'
  | 'extracting'
  | 'downloading'
  | 'done'
  | 'error';

export interface DownloadItem {
  id: string;
  episodeNum: number;
  seriesTitle: string;
  slug: string;
  season: string;
  status: DownloadStatus;
  bytesWritten: number;
  totalBytes: number;
  filePath?: string;
  subtitlePath?: string;
  error?: string;
  token: string;
  tokenType: string;
  episodeUrl?: string;
  addedAt: number;
}

interface DownloadContextValue {
  downloads: DownloadItem[];
  addEpisodes: (episodes: {
    num: number;
    token: string;
    tokenType: string;
    slug: string;
    season: string;
    title: string;
    episodeUrl?: string;
  }[]) => void;
  cancelDownload: (id: string) => void;
  clearCompleted: () => void;
  clearAll: () => void;
}

const DownloadContext = createContext<DownloadContextValue | null>(null);

function getApiBase(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain || domain === 'REPLACE_WITH_DEPLOYED_API_DOMAIN' || domain === 'undefined') {
    throw new Error('API sunucusu yapılandırılmamış.');
  }
  return `https://${domain}/api/drama`;
}

function makeId(): string {
  return Date.now().toString() + Math.random().toString(36).substring(2, 9);
}

export function DownloadProvider({ children }: { children: React.ReactNode }) {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const isProcessingRef = useRef(false);
  const cancelledRef = useRef<Set<string>>(new Set());
  const activeResumableRef = useRef<FileSystem.DownloadResumable | null>(null);
  const downloadsRef = useRef<DownloadItem[]>([]);
  downloadsRef.current = downloads;

  const updateItem = useCallback((id: string, patch: Partial<DownloadItem>) => {
    setDownloads((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch } : d))
    );
  }, []);

  const processNext = useCallback(async () => {
    if (isProcessingRef.current) return;

    const queued = downloadsRef.current.find((d) => d.status === 'queued');
    if (!queued) {
      isProcessingRef.current = false;
      return;
    }

    isProcessingRef.current = true;

    try {
      if (cancelledRef.current.has(queued.id)) {
        updateItem(queued.id, { status: 'error', error: 'İptal edildi' });
        isProcessingRef.current = false;
        setTimeout(processNext, 100);
        return;
      }

      // Step 1: Fetch embed page — first collect session cookies from episode page,
      // then use them on the embed request (Cloudflare requires a valid cf_clearance cookie).
      // If direct device fetch fails or returns no m3u8, fall back to server-side /embed.
      updateItem(queued.id, { status: 'extracting' });

      const type = queued.tokenType === 'token' ? 'token' : 'ct';
      const embedPageUrl =
        type === 'token'
          ? `https://dramadizilerim.com/embed.php?token=${encodeURIComponent(queued.token)}&v=2`
          : `https://dramadizilerim.com/embed.php?ct=${encodeURIComponent(queued.token)}`;

      const MOBILE_UA =
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36';
      const episodeReferer = queued.episodeUrl ?? 'https://dramadizilerim.com/';

      // --- Attempt 1: on-device fetch with session cookie ---
      let embedHtml: string | null = null;
      try {
        // 1a: visit episode page to get Cloudflare session cookie
        let cookieStr = '';
        try {
          const epRes = await fetch(episodeReferer, {
            headers: {
              'User-Agent': MOBILE_UA,
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
            },
            redirect: 'follow',
          });
          const rawCookie = epRes.headers.get('set-cookie') ?? '';
          if (rawCookie) {
            // "name=value; attrs, name2=value2; attrs" — split on comma before each new cookie
            cookieStr = rawCookie
              .split(/,\s*(?=[^;]+=[^;,]+)/)
              .map((c) => c.split(';')[0]!.trim())
              .filter(Boolean)
              .join('; ');
          }
        } catch {
          // proceed without cookie
        }

        // 1b: fetch embed page with the collected cookie
        const embedRes = await fetch(embedPageUrl, {
          headers: {
            'User-Agent': MOBILE_UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
            'Referer': episodeReferer,
            ...(cookieStr ? { 'Cookie': cookieStr } : {}),
          },
        });

        if (embedRes.ok) {
          const html = await embedRes.text();
          // Accept only if it actually contains a video source (not an Access Denied page)
          if (/m3u8|source\s*=|<source/.test(html)) {
            embedHtml = html;
          }
        }
      } catch {
        // fall through to server-side attempt
      }

      // --- Attempt 2: server-side /embed (has full cookie + header handling) ---
      let m3u8Url: string | null = null;
      let subtitleUrl: string | null = null;

      if (embedHtml) {
        // Parse from on-device HTML
        const sourceMatch =
          embedHtml.match(/let source\s*=\s*"([^"]+\.m3u8[^"]*)"/) ??
          embedHtml.match(/source\s*=\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/) ??
          embedHtml.match(/<source[^>]+src="(https?:\/\/[^"]+\.m3u8[^"]*)"/) ??
          embedHtml.match(/"(https:\/\/dizi\.dramadizilerim\.com\/\?url=[^"]+\.m3u8[^"]*)"/);
        m3u8Url = sourceMatch?.[1] ?? null;

        const srtCommentMatch = embedHtml.match(/first subtitle url:\s*(https?:\/\/\S+\.srt)/);
        const srtProxyMatch = embedHtml.match(/(https?:\/\/dizi\.dramadizilerim\.com\/\?url=[^\s"]+\.srt)/);
        const captionTokenMatch = embedHtml.match(/window\._captionUrl\s*=\s*"([^"]+)"/);
        subtitleUrl =
          srtCommentMatch?.[1] ??
          srtProxyMatch?.[1] ??
          (captionTokenMatch ? `https://dramadizilerim.com/${captionTokenMatch[1]}` : null);
      }

      if (!m3u8Url) {
        // On-device fetch failed or was blocked — try via server proxy
        try {
          const apiBase = getApiBase();
          const serverUrl = `${apiBase}/embed?token=${encodeURIComponent(queued.token)}&tokenType=${encodeURIComponent(type)}${queued.episodeUrl ? `&episodeUrl=${encodeURIComponent(queued.episodeUrl)}` : ''}`;
          const serverRes = await fetch(serverUrl);
          if (serverRes.ok) {
            const data = await serverRes.json() as { m3u8Url?: string; subtitleUrl?: string | null };
            m3u8Url = data.m3u8Url ?? null;
            subtitleUrl = data.subtitleUrl ?? null;
          }
        } catch {
          // fall through — will throw below
        }
      }

      const embedData = { m3u8Url, subtitleUrl };

      if (!embedData.m3u8Url) {
        throw new Error('Video URL bulunamadı. Site erişimi engelliyor olabilir.');
      }

      if (cancelledRef.current.has(queued.id)) {
        updateItem(queued.id, { status: 'error', error: 'İptal edildi' });
        isProcessingRef.current = false;
        setTimeout(processNext, 100);
        return;
      }

      // Step 2: Download video via stream endpoint
      updateItem(queued.id, { status: 'downloading' });

      const epStr = queued.episodeNum.toString().padStart(2, '0');
      const fileName = `${queued.slug}_S${queued.season}E${epStr}.mp4`;
      const dirPath = `${FileSystem.documentDirectory}drama-downloads/`;
      await FileSystem.makeDirectoryAsync(dirPath, { intermediates: true });
      const filePath = dirPath + fileName;

      const streamUrl = `${getApiBase()}/stream-video?m3u8Url=${encodeURIComponent(
        embedData.m3u8Url
      )}&quality=1`;

      const resumable = FileSystem.createDownloadResumable(
        streamUrl,
        filePath,
        {},
        (progress) => {
          updateItem(queued.id, {
            bytesWritten: progress.totalBytesWritten,
            totalBytes:
              progress.totalBytesExpectedToWrite > 0
                ? progress.totalBytesExpectedToWrite
                : 0,
          });
        }
      );

      activeResumableRef.current = resumable;
      const result = await resumable.downloadAsync();
      activeResumableRef.current = null;

      if (cancelledRef.current.has(queued.id)) {
        try {
          await FileSystem.deleteAsync(filePath, { idempotent: true });
        } catch {}
        updateItem(queued.id, { status: 'error', error: 'İptal edildi' });
        isProcessingRef.current = false;
        setTimeout(processNext, 100);
        return;
      }

      if (!result || result.status !== 200) {
        throw new Error('İndirme başarısız oldu');
      }

      // Step 3: Download subtitle
      let subtitlePath: string | undefined;
      if (embedData.subtitleUrl) {
        try {
          const subFileName = fileName.replace('.mp4', '.srt');
          subtitlePath = dirPath + subFileName;
          const subUrl = `${getApiBase()}/subtitle?url=${encodeURIComponent(
            embedData.subtitleUrl
          )}`;
          await FileSystem.downloadAsync(subUrl, subtitlePath);
        } catch (subErr) {
          // Subtitle failure is non-fatal
          subtitlePath = undefined;
        }
      }

      updateItem(queued.id, {
        status: 'done',
        filePath: result.uri,
        subtitlePath,
      });
    } catch (err) {
      activeResumableRef.current = null;
      const message =
        err instanceof Error ? err.message : 'Bilinmeyen hata';
      updateItem(queued.id, { status: 'error', error: message });
    }

    isProcessingRef.current = false;
    setTimeout(processNext, 200);
  }, [updateItem]);

  const addEpisodes = useCallback(
    (
      episodes: {
        num: number;
        token: string;
        tokenType: string;
        slug: string;
        season: string;
        title: string;
        episodeUrl?: string;
      }[]
    ) => {
      const existing = downloadsRef.current;
      const newItems: DownloadItem[] = [];

      for (const ep of episodes) {
        const alreadyQueued = existing.some(
          (d) =>
            d.slug === ep.slug &&
            d.season === ep.season &&
            d.episodeNum === ep.num &&
            d.status !== 'error'
        );
        if (!alreadyQueued) {
          newItems.push({
            id: makeId(),
            episodeNum: ep.num,
            seriesTitle: ep.title,
            slug: ep.slug,
            season: ep.season,
            status: 'queued',
            bytesWritten: 0,
            totalBytes: 0,
            token: ep.token,
            tokenType: ep.tokenType,
            episodeUrl: ep.episodeUrl,
            addedAt: Date.now(),
          });
        }
      }

      if (newItems.length > 0) {
        setDownloads((prev) => [...prev, ...newItems]);
        setTimeout(processNext, 100);
      }
    },
    [processNext]
  );

  const cancelDownload = useCallback(
    async (id: string) => {
      cancelledRef.current.add(id);
      const item = downloadsRef.current.find((d) => d.id === id);
      if (item?.status === 'downloading' && activeResumableRef.current) {
        try {
          await activeResumableRef.current.cancelAsync();
          activeResumableRef.current = null;
        } catch {}
      }
      updateItem(id, { status: 'error', error: 'İptal edildi' });
    },
    [updateItem]
  );

  const clearCompleted = useCallback(() => {
    setDownloads((prev) => prev.filter((d) => d.status !== 'done'));
  }, []);

  const clearAll = useCallback(() => {
    setDownloads([]);
  }, []);

  return (
    <DownloadContext.Provider
      value={{
        downloads,
        addEpisodes,
        cancelDownload,
        clearCompleted,
        clearAll,
      }}
    >
      {children}
    </DownloadContext.Provider>
  );
}

export function useDownloads(): DownloadContextValue {
  const ctx = useContext(DownloadContext);
  if (!ctx) throw new Error('useDownloads must be used inside DownloadProvider');
  return ctx;
}
