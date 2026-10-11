/**
 * api-gateway 入口。
 *
 * 启动: npm run build && npm run start   （或 node --experimental-sqlite dist/main.js）
 * 默认端口 8080（与 crawler 8100 / intelligence 8090 并列）。
 */

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });

  // 开发环境放开跨域，便于控制台与插件联调
  app.enableCors({
    origin: true,
    credentials: true,
    exposedHeaders: ['X-Trace-Id', 'Content-Disposition'],
  });

  app.enableShutdownHooks();

  const port = Number(process.env.PORT || 8080);
  await app.listen(port, process.env.HOST || '0.0.0.0');
  new Logger('Bootstrap').log(`api-gateway 已启动：http://localhost:${port}（健康检查 /health）`);
}

bootstrap();
