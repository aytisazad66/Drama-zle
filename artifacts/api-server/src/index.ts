import app from "./app";
import { logger } from "./lib/logger";
import { startDramaAutomation } from "./services/dramaAutomation";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void startDramaAutomation().catch((error) => {
    logger.error(
      { message: error instanceof Error ? error.message : "startup failed" },
      "Drama automation could not start",
    );
  });
});
