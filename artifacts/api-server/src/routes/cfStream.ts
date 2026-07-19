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
  const res = await fetch(url, {
    headers: { ...BASE_HEADERS, Accept: '*/*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function proxyFetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { ...BASE_HEADERS, Accept: '*/*' },
  });
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

function parseVariantM3u8(text: string): {
  initUrl: string | null;
  segments: string[];
} {
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
    try {
      chunks.push(await proxyFetchBuffer(initUrl));
    } catch (e) {
      // init segment failure is non-fatal
    }
  }

  for (const segUrl of segments) {
    try {
      chunks.push(await proxyFetchBuffer(segUrl));
    } catch {
      // skip bad segments
    }
  }

  if (chunks.length === 0) throw new Error('Hiç segment indirilemedi');
  return Buffer.concat(chunks);
}

/**
 * POST /api/drama/cf-upload
 *
 * Uploads a video to Cloudflare Stream.
 *
 * - HLS: buffers all segments on our server, then uploads as multipart/form-data
 *   so CF gets a known Content-Length (copy-from-URL fails for HLS because CF
 *   can't determine stream size from our chunked endpoint).
 * - MP4: uses CF copy-from-URL (CF fetches from our stream-video proxy which
 *   passes through Content-Length from the upstream MP4 server).
 */
router.post('/cf-upload', async (req, res) => {
  const { videoUrl, name, creator } = req.body as {
    videoUrl?: string;
    name?: string;
    creator?: string;
  };

  if (!videoUrl || !name) {
    return res
      .status(400)
      .json({ error: 'Geçersiz istek: videoUrl ve name zorunlu' });
  }

  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_STREAM_TOKEN;
  if (!accountId || !token) {
    return res
      .status(500)
      .json({ error: 'Cloudflare kimlik bilgileri yapılandırılmamış' });
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

  // ── HLS: assemble segments locally, direct multipart upload ──────────────
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
    formData.append(
      'file',
      new Blob([videoBuffer], { type: 'video/mp4' }),
      `${name}.mp4`,
    );
    if (creator) formData.append('creator', creator);

    const cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      },
    );

    if (!cfRes.ok) {
      const errText = await cfRes.text();
      req.log.error({ cfStatus: cfRes.status, cfBody: errText, name }, 'CF HLS upload failed');
      return res
        .status(502)
        .json({ error: 'Cloudflare API hatası', details: errText });
    }

    const data = (await cfRes.json()) as {
      result: {
        uid: string;
        playback: { hls: string; dash: string };
        thumbnail: string;
        status: { state: string };
      };
      success: boolean;
      errors: { message: string }[];
    };

    if (!data.success) {
      return res.status(502).json({
        error: 'CF yükleme başarısız',
        details: data.errors?.map((e) => e.message),
      });
    }

    return res.json({
      uid: data.result.uid,
      hlsUrl: data.result.playback?.hls ?? null,
      dashUrl: data.result.playback?.dash ?? null,
      thumbnailUrl: data.result.thumbnail ?? null,
      state: data.result.status?.state ?? 'queued',
    });
  }

  // ── MP4: copy-from-URL (CF fetches from our proxy, Content-Length intact) ─
  req.log.info({ videoUrl, name }, 'CF upload: copy-from-URL (MP4)');

  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/copy`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: videoUrl, meta: { name }, creator: creator ?? '' }),
    },
  );

  if (!cfRes.ok) {
    const errText = await cfRes.text();
    req.log.error({ cfStatus: cfRes.status, cfBody: errText, videoUrl }, 'CF MP4 copy failed');
    return res
      .status(502)
      .json({ error: 'Cloudflare API hatası', details: errText });
  }

  const data = (await cfRes.json()) as {
    result: {
      uid: string;
      playback: { hls: string; dash: string };
      thumbnail: string;
      status: { state: string };
    };
    success: boolean;
    errors: { message: string }[];
  };

  if (!data.success) {
    return res.status(502).json({
      error: 'CF yükleme başarısız',
      details: data.errors?.map((e) => e.message),
    });
  }

  return res.json({
    uid: data.result.uid,
    hlsUrl: data.result.playback?.hls ?? null,
    dashUrl: data.result.playback?.dash ?? null,
    thumbnailUrl: data.result.thumbnail ?? null,
    state: data.result.status?.state ?? 'queued',
  });
});

export default router;
