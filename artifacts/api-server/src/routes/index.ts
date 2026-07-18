import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dramaRouter from "./drama";
import cfStreamRouter from "./cfStream";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/drama", dramaRouter);
router.use("/drama", cfStreamRouter);

export default router;
