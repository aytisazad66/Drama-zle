import { Router, type Request, type Response } from "express";
import { getDramaAutomationStatus } from "../services/dramaAutomation";

const router = Router();

router.get("/automation/status", async (req: Request, res: Response) => {
  try {
    res.json(await getDramaAutomationStatus());
  } catch (error) {
    req.log.error({ error }, "drama automation status failed");
    res.status(503).json({ error: "Otomasyon durumu şu anda alınamıyor" });
  }
});

export default router;
