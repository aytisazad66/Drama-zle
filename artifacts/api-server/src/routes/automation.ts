import { Router, type Request, type Response } from "express";
import {
  getDramaAutomationStatus,
  startDramaAutomation,
  stopDramaAutomation,
} from "../services/dramaAutomation";

const router = Router();

router.post("/automation/start", async (req: Request, res: Response) => {
  try {
    await startDramaAutomation();
    res.json(await getDramaAutomationStatus());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Cloudflare Stream yüklemesi başlatılamadı";
    req.log.error({ message }, "drama automation start failed");
    res.status(503).json({ error: message });
  }
});

router.post("/automation/stop", async (req: Request, res: Response) => {
  try {
    await stopDramaAutomation();
    res.json(await getDramaAutomationStatus());
  } catch (error) {
    req.log.error({ error }, "drama automation stop failed");
    res.status(503).json({ error: "Cloudflare Stream yüklemesi durdurulamadı" });
  }
});

router.get("/automation/status", async (req: Request, res: Response) => {
  try {
    res.json(await getDramaAutomationStatus());
  } catch (error) {
    req.log.error({ error }, "drama automation status failed");
    res.status(503).json({ error: "Otomasyon durumu şu anda alınamıyor" });
  }
});

export default router;
