import 'dotenv/config';
import { loadConfig } from './config';
import { createServer } from './gateway/server';
import { logger } from './observability/logger';

const config = loadConfig();
const app = createServer();

if (require.main === module) {
  app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'gateway listening (phase 1 skeleton)');
  });
}

export default app;
