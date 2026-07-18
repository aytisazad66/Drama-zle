import { Router } from 'express';

const router = Router();

/**
 * POST /api/drama/cf-upload
 *
 * Tells Cloudflare Stream to fetch the video from our stream-video proxy URL.
 * CF downloads it themselves — no body streaming needed.
 */
router.post('/cf-upload', async (req, res) => {
  const { videoUrl, name } = req.body as {
    videoUrl?: string;
    name?: string;
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

  // Use CF Stream copy-from-URL: CF fetches the video from our proxy server.
  // Our /stream-video endpoint handles both HLS assembly and MP4 proxying with
  // the correct Referer headers — CF just sees a plain video stream.
  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/copy`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: videoUrl,
        meta: { name },
      }),
    },
  );

  if (!cfRes.ok) {
    const errText = await cfRes.text();
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
