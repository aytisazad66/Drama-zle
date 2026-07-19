import { Router } from 'express';
import { URL } from 'url';

const router = Router();

const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
  Referer: 'https://dramadizilerim.com/',
  Origin: 'https://dramadizilerim.com',
};

async function proxyFetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { ...BASE_HEADERS, Accept: '*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function proxyFetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { ...BASE_HEADERS, Accept: '*/*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function parseMasterM3u8(text: string): { bandwidth: number; url: string }[] {
  const lines = text.split('\n');
  const variants: { bandwidth: number; url: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const url = lines[i + 1]?.trim();
      if (url && !url.startsWith('#')) {
        variants.push({ bandwidth: bwMatch ? parseInt(bwMatch[1]!) : 0, url });
      }
    }
  }
  return variants.sort((a, b) => b.bandwidth - a.bandwidth);
}

function parseVariantM3u8(text: string): { initUrl: string | null; segments: string[] } {
  const lines = text.split('\n');
  const segments: string[] = [];
  let initUrl: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith('#EXT-X-MAP:URI=')) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) initUrl = m[1]!;
    } else if (line.startsWith('#EXTINF:')) {
      const segUrl = lines[i + 1]?.trim();
      if (segUrl && !segUrl.startsWith('#')) segments.push(segUrl);
    }
  }
  return { initUrl, segments };
}

/** Download all HLS segments and concatenate into a single MP4 buffer. */
async function assembleHls(m3u8Url: string, qualityIndex: number): Promise<Buffer> {
  const masterText = await proxyFetchText(m3u8Url);
  const variants = parseMasterM3u8(masterText);

  let variantText: string;
  if (variants.length > 0) {
    const selected = variants[Math.min(qualityIndex, variants.length - 1)]!;
    variantText = await proxyFetchText(selected.url);
  } else if (masterText.includes('#EXTINF:')) {
    variantText = masterText;
  } else {
    throw new Error('HLS playlist içinde video segmenti bulunamadı');
  }

  const { initUrl, segments } = parseVariantM3u8(variantText);
  const chunks: Buffer[] = [];

  if (initUrl) {
    try { chunks.push(await proxyFetchBuffer(initUrl)); } catch { /* non-fatal */ }
  }
  for (const segUrl of segments) {
    try { chunks.push(await proxyFetchBuffer(segUrl)); } catch { /* skip bad segment */ }
  }

  if (chunks.length === 0) throw new Error('Hiç segment indirilemedi');
  return Buffer.concat(chunks);
}

/**
 * Set creator on a CF Stream video after upload.
 * Must be done as a separate request — multipart direct-upload ignores the creator form field.
 */
async function setCfMeta(
  accountId: string,
  token: string,
  uid: string,
  fields: { creator?: string; episodeNum?: number; season?: string },
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (fields.creator) body.creator = fields.creator;
  if (fields.episodeNum !== undefined || fields.season !== undefined) {
    body.meta = {
      ...(fields.episodeNum !== undefined && { episode: String(fields.episodeNum) }),
      ...(fields.season !== undefined && { season: fields.season }),
    };
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${uid}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CF meta set failed (${res.status}): ${err}`);
  }
}

/**
 * Upload a subtitle file to CF Stream as a caption track.
 * Non-fatal — failure is logged but does not fail the video upload.
 *
 * CF API: PUT /accounts/{id}/stream/{uid}/captions/{language}
 * Body: multipart/form-data with field "file" = SRT/VTT content.
 */
async function uploadCaption(
  accountId: string,
  token: string,
  uid: string,
  subtitleUrl: string,
  language = 'tr',
): Promise<void> {
  const subtitleText = await proxyFetchText(subtitleUrl);

  // Detect format: VTT starts with "WEBVTT", otherwise treat as SRT
  const isVtt = subtitleText.trimStart().startsWith('WEBVTT');
  const mimeType = isVtt ? 'text/vtt' : 'application/x-subrip';
  const ext = isVtt ? 'vtt' : 'srt';

  const form = new FormData();
  form.append(
    'file',
    new Blob([subtitleText], { type: mimeType }),
    `caption_${language}.${ext}`,
  );

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${uid}/captions/${language}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`CF caption upload failed (${res.status}): ${errText}`);
  }
}

/** Parse the CF Stream result shape (shared by both upload paths). */
function parseCfResult(data: {
  result: {
    uid: string;
    playback?: { hls?: string; dash?: string };
    thumbnail?: string;
    status?: { state?: string };
  };
  success: boolean;
  errors?: { message: string }[];
}) {
  return {
    uid: data.result.uid,
    hlsUrl: data.result.playback?.hls ?? null,
    dashUrl: data.result.playback?.dash ?? null,
    thumbnailUrl: data.result.thumbnail ?? null,
    state: data.result.status?.state ?? 'queued',
  };
}

/**
 * POST /api/drama/cf-upload
 *
 * Uploads a video to Cloudflare Stream, then (optionally) attaches a caption track.
 *
 * - HLS: buffers all segments on our server → direct multipart upload to CF
 *   (copy-from-URL fails for HLS because CF can't determine stream size from
 *   our chunked endpoint).
 * - MP4: copy-from-URL (CF fetches from our stream-video proxy which passes
 *   Content-Length from the upstream server).
 *
 * Body fields:
 *   videoUrl   — our /stream-video proxy URL
 *   name       — video identifier (e.g. "sen-bana-aitsin_S1E01")
 *   creator    — series title for CF grouping (e.g. "Sen Bana Aitsin")
 *   subtitleUrl — (optional) direct SRT/VTT URL; uploaded as Turkish caption
 */
router.post('/cf-upload', async (req, res) => {
  const { videoUrl, name, creator, subtitleUrl, episodeNum, season } = req.body as {
    videoUrl?: string;
    name?: string;
    creator?: string;
    subtitleUrl?: string;
    episodeNum?: number;
    season?: string;
  };

  if (!videoUrl || !name) {
    return res.status(400).json({ error: 'Geçersiz istek: videoUrl ve name zorunlu' });
  }

  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_STREAM_TOKEN;
  if (!accountId || !token) {
    return res.status(500).json({ error: 'Cloudflare kimlik bilgileri yapılandırılmamış' });
  }

  // Parse the stream-video proxy URL to extract original params
  let m3u8Url: string = videoUrl;
  let videoType: string = 'mp4';
  let qualityIndex = 1;

  try {
    const parsed = new URL(videoUrl);
    m3u8Url = parsed.searchParams.get('m3u8Url') ?? videoUrl;
    videoType = parsed.searchParams.get('videoType') ?? 'mp4';
    qualityIndex = parseInt(parsed.searchParams.get('quality') ?? '1') || 1;
  } catch {
    // videoUrl is already a direct URL — use as-is
  }

  const isHls = videoType === 'hls' || m3u8Url.includes('.m3u8');

  // Helper: upload caption after we have the uid, non-fatal
  async function maybeUploadCaption(uid: string) {
    if (!subtitleUrl) return;
    try {
      await uploadCaption(accountId!, token!, uid, subtitleUrl);
      req.log.info({ uid, subtitleUrl }, 'CF caption uploaded');
    } catch (err) {
      req.log.warn({ err, uid, subtitleUrl }, 'CF caption upload failed (non-fatal)');
    }
  }

  // ── HLS: assemble segments locally, direct multipart upload ────────────────
  if (isHls) {
    req.log.info({ m3u8Url, qualityIndex, name }, 'CF upload: assembling HLS');

    let videoBuffer: Buffer;
    try {
      videoBuffer = await assembleHls(m3u8Url, qualityIndex);
    } catch (err) {
      req.log.error({ err, m3u8Url }, 'HLS assembly failed');
      return res.status(502).json({ error: 'HLS video indirilemedi' });
    }

    req.log.info({ bytes: videoBuffer.length, name }, 'HLS assembled, uploading to CF');

    const formData = new FormData();
    formData.append('file', new Blob([videoBuffer], { type: 'video/mp4' }), `${name}.mp4`);
    if (creator) formData.append('creator', creator);

    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );

    if (!cfRes.ok) {
      const errText = await cfRes.text();
      req.log.error({ cfStatus: cfRes.status, cfBody: errText, name }, 'CF HLS upload failed');
      return res.status(502).json({ error: 'Cloudflare API hatası', details: errText });
    }

    const data = await cfRes.json() as { result: any; success: boolean; errors?: { message: string }[] };
    if (!data.success) {
      return res.status(502).json({ error: 'CF yükleme başarısız', details: data.errors?.map((e) => e.message) });
    }

    const result = parseCfResult(data);
    if (creator) {
      try { await setCfMeta(accountId!, token!, result.uid, { creator, episodeNum, season }); }
      catch (err) { req.log.warn({ err, uid: result.uid }, 'CF meta set failed (non-fatal)'); }
    }
    await maybeUploadCaption(result.uid);
    return res.json(result);
  }

  // ── MP4: copy-from-URL (CF fetches from our proxy, Content-Length intact) ──
  req.log.info({ videoUrl, name }, 'CF upload: copy-from-URL (MP4)');

  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/copy`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: videoUrl, meta: { name }, creator: creator ?? '' }),
    },
  );

  if (!cfRes.ok) {
    const errText = await cfRes.text();
    req.log.error({ cfStatus: cfRes.status, cfBody: errText, videoUrl }, 'CF MP4 copy failed');
    return res.status(502).json({ error: 'Cloudflare API hatası', details: errText });
  }

  const data = await cfRes.json() as { result: any; success: boolean; errors?: { message: string }[] };
  if (!data.success) {
    return res.status(502).json({ error: 'CF yükleme başarısız', details: data.errors?.map((e) => e.message) });
  }

  const result = parseCfResult(data);
  if (creator) {
    try { await setCfMeta(accountId!, token!, result.uid, { creator, episodeNum, season }); }
    catch (err) { req.log.warn({ err, uid: result.uid }, 'CF meta set failed (non-fatal)'); }
  }
  await maybeUploadCaption(result.uid);
  return res.json(result);
});

export default router;
