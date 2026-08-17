import { buildApp } from './app';
import { config } from './config';

async function main() {
  const app = await buildApp();

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

void main();
