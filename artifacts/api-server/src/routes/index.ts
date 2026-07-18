import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dramaRouter from "./drama";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/drama", dramaRouter);

export default router;
