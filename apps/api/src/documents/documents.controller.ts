import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt.guard';
import { BizError } from '../common/biz-error';
import { DocumentsService } from './documents.service';

type Traced = Request & { traceId?: string };

/**
 * 读取原始请求体。
 * 不引入 raw body parser：Express 的 json/urlencoded 解析器只在 content-type 匹配时消费流，
 * 二进制上传（`application/octet-stream` 等）不会被消费，这里直接读流即可，零依赖。
 */
async function readRawBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as any) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

@Controller('api/v1')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Post('documents/presign')
  presign(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.docs.presign(user.userId, body);
  }

  /**
   * 上传端点：客户端拿 presign 返回的 upload_url 直接 PUT 原始字节到这里。
   *
   * 两处细节：
   *   * 路由用 `{*splat}` 而非 `*` —— Express 5 / path-to-regexp v8 已移除裸 `*`，
   *     且 file_key 含多级目录（如 `u/1/cv/xxx.pdf`），必须匹配多段
   *   * 用 `@Res()` 自行响应——需要绕过 JSON 封装拦截器，直接回原始结果
   */
  @Put('documents/upload/{*splat}')
  async upload(@CurrentUser() user: AuthUser, @Req() req: Traced, @Res() res: Response) {
    const p = (req.params as any)?.splat;
    const raw = Array.isArray(p) ? p.join('/') : String(p || '');
    try {
      const key = decodeURIComponent(raw);
      const bytes = await readRawBody(req);
      const saved = await this.docs.saveObject(user.userId, key, bytes);
      res.json({
        code: 0, message: 'ok', data: saved, trace_id: req.traceId || '',
      });
    } catch (e: any) {
      const code = e?.code ?? 1001;
      const status = e?.httpStatus ?? 400;
      res.status(status).json({
        code,
        message: e?.message || '上传失败',
        data: null,
        trace_id: req.traceId || '',
      });
    }
  }

  @Post('documents')
  register(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.docs.register(user.userId, body);
  }

  /** 下载 / 预览已登记材料的内容 */
  @Get('documents/:id/content')
  download(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    try {
      const { row, bytes } = this.docs.readObject(user.userId, id);
      res.setHeader('Content-Type', row.mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.file_name)}"`);
      res.send(bytes);
    } catch (e: any) {
      res.status(e?.httpStatus ?? 404).json({
        code: e?.code ?? 2001,
        message: e?.message || '材料不存在',
        data: null,
        trace_id: '',
      });
    }
  }

  @Get('documents')
  list(@CurrentUser() user: AuthUser, @Query('doc_type') docType?: string) {
    return this.docs.list(user.userId, docType);
  }

  @Delete('documents/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.docs.remove(user.userId, id);
  }

  @Post('resumes/parse')
  parse(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.docs.parseResume(user.userId, body);
  }

  @Get('resumes')
  listResumes(@CurrentUser() user: AuthUser) {
    return this.docs.listResumes(user.userId);
  }

  @Put('resumes/:id')
  updateResume(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.docs.updateResume(user.userId, id, body);
  }
}
