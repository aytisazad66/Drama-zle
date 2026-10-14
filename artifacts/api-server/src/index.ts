import app from "./app";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { stopDramaAutomation } from "./services/dramaAutomation";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown started");

  await stopDramaAutomation(true);
  await new Promise<void>((resolve) => {
    server.close((error) => {
      if (error) logger.error({ err: error }, "HTTP server shutdown failed");
      resolve();
    });
  });
  await pool.end();
  logger.info({ signal }, "Graceful shutdown completed");
}

process.once("SIGTERM", () => {
  void shutdown("SIGTERM").catch((error) => {
    logger.error({ err: error }, "Graceful shutdown failed");
    process.exit(1);
  });
});
process.once("SIGINT", () => {
  void shutdown("SIGINT").catch((error) => {
    logger.error({ err: error }, "Graceful shutdown failed");
    process.exit(1);
  });
});
