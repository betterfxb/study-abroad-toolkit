/**
 * 材料与简历模块（契约 §3）。
 *
 * POST   /api/v1/documents/presign       获取对象存储预签名上传 URL
 * POST   /api/v1/documents               登记已上传材料
 * GET    /api/v1/documents?doc_type=...  列出材料
 * DELETE /api/v1/documents/{id}          删除材料
 * POST   /api/v1/resumes/parse           简历文本 → 结构化 JSON
 * GET    /api/v1/resumes                 简历版本列表
 * PUT    /api/v1/resumes/{id}            更新简历内容
 *
 * PoC 说明：预签名 URL 指向本地占位端点（未接对象存储）；简历解析用启发式规则，
 * 生产环境应改走 intelligence-service 的 LLM 解析（`/internal/polish` 同族接口）。
 */

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BizError } from '../common/biz-error';
import { DatabaseService } from '../db/database.service';
import { resolveStorageDriver, type StorageDriver } from './storage';

const DOC_TYPES = ['transcript', 'degree', 'passport', 'cv', 'ps', 'recommendation', 'other'];
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const PRESIGN_TTL_SEC = 900;

export interface DocumentRow {
  id: number;
  user_id: number;
  doc_type: string;
  file_name: string;
  file_key: string;
  mime: string;
  file_size: number;
  created_at: string;
}

export interface ResumeRow {
  id: number;
  user_id: number;
  name: string;
  source_text: string;
  parsed: string;
  version: number;
  created_at: string;
  updated_at: string;
}

/**
 * 启发式简历解析：从纯文本抽取结构化信息。
 * 明确标注 method='heuristic'，提示结果需人工确认。
 */
export function parseResumeText(text: string) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const email = (src.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [''])[0];
  const phone = (src.match(/(?:\+?86[-\s]?)?1[3-9]\d{9}/) || src.match(/\+\d[\d\s-]{6,}\d/) || [''])[0];
  const name = lines[0] && lines[0].length <= 24 && !/[@\d]/.test(lines[0]) ? lines[0] : '';

  const DEGREE_HINTS: [RegExp, string][] = [
    [/ph\.?d|doctor/i, 'Doctoral'],
    [/master|硕士|m\.?s\.?c?\b/i, 'Master'],
    [/bachelor|本科|b\.?s\.?c?\b/i, 'Bachelor'],
  ];
  const education: any[] = [];
  for (const [re, degree] of DEGREE_HINTS) {
    if (re.test(src)) {
      education.push({ degree, institution: '', major: '', start: '', end: '' });
    }
  }

  const SKILL_POOL = [
    'Python', 'Java', 'JavaScript', 'TypeScript', 'C++', 'Go', 'Rust', 'SQL',
    'React', 'Vue', 'Node.js', 'Django', 'FastAPI', 'Spring', 'Docker', 'Kubernetes',
    'AWS', 'GCP', 'Azure', 'Machine Learning', 'Deep Learning', 'NLP', 'PyTorch', 'TensorFlow',
    'Pandas', 'Spark', 'Hadoop', 'Redis', 'PostgreSQL', 'MySQL', 'MongoDB', 'Git', 'Linux',
  ];
  const lower = src.toLowerCase();
  const skills = SKILL_POOL.filter((s) => lower.includes(s.toLowerCase()));

  return {
    basic_info: { name, email, phone },
    education,
    skills,
    sections: detectSections(lines),
    method: 'heuristic',
    note: '启发式解析结果，请人工核对后再使用',
  };
}

function detectSections(lines: string[]): string[] {
  const KEYS = ['教育', '实习', '工作', '项目', '技能', '获奖', '论文', 'education', 'experience', 'projects', 'skills', 'awards', 'publications'];
  return lines.filter((l) => l.length <= 20 && KEYS.some((k) => l.toLowerCase().includes(k)));
}

@Injectable()
export class DocumentsService {
  private readonly storage: StorageDriver;

  constructor(private readonly db: DatabaseService) {
    this.storage = resolveStorageDriver();
  }

  /** 当前存储驱动名（测试与运维观测用） */
  get driverName() {
    return this.storage.name;
  }

  // ------------------------------------------------------------ 预签名
  presign(userId: number, body: any) {
    const fileName = String(body?.file_name || '').trim();
    if (!fileName) throw BizError.invalid('缺少 file_name');
    const docType = String(body?.doc_type || 'other');
    if (!DOC_TYPES.includes(docType)) {
      throw BizError.invalid(`doc_type 非法（可用：${DOC_TYPES.join(', ')}）`);
    }
    const size = Number(body?.file_size || 0);
    if (!Number.isFinite(size) || size < 0) throw BizError.invalid('file_size 非法');
    if (size > MAX_FILE_SIZE) throw BizError.invalid('文件超过 20MB 限制');

    const ext = fileName.includes('.') ? fileName.split('.').pop() : 'bin';
    const fileKey = `u/${userId}/${docType}/${randomUUID()}.${ext}`;
    return {
      upload_url: this.storage.url(fileKey),
      file_key: fileKey,
      expires_in: PRESIGN_TTL_SEC,
      method: 'PUT',
      driver: this.storage.name,
      note: this.storage.name === 'local'
        ? '本地存储驱动：向 upload_url PUT 原始字节即可完成上传；生产环境配置 STORAGE_DRIVER=s3 后返回真实预签名 URL'
        : '对象存储预签名 URL',
    };
  }

  /**
   * 落盘上传内容。
   * 归属校验放在这里而不是控制器：file_key 来自请求体，**必须**校验它属于当前用户，
   * 否则任何登录用户都能往别人的目录写文件。
   */
  async saveObject(userId: number, key: string, bytes: Buffer) {
    const k = String(key || '').trim();
    if (!k) throw BizError.invalid('缺少 file_key');
    if (!k.startsWith(`u/${userId}/`)) throw BizError.forbidden('file_key 不属于当前用户');
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw BizError.invalid('上传内容为空');
    if (bytes.length > MAX_FILE_SIZE) throw BizError.invalid('文件超过 20MB 限制');
    return this.storage.put(k, bytes);
  }

  /** 回读已登记材料的内容（用于下载 / 预览） */
  readObject(userId: number, id: number) {
    const row = this.db.get<DocumentRow>(
      'SELECT * FROM documents WHERE id = ? AND user_id = ?', id, userId,
    );
    if (!row) throw BizError.notFound('材料不存在');
    if (!this.storage.exists(row.file_key)) throw BizError.notFound('文件内容不存在');
    return { row, bytes: this.storage.read(row.file_key) };
  }

  register(userId: number, body: any) {
    const fileKey = String(body?.file_key || '').trim();
    const fileName = String(body?.file_name || '').trim();
    if (!fileKey || !fileName) throw BizError.invalid('缺少 file_key 或 file_name');
    const docType = String(body?.doc_type || 'other');
    if (!DOC_TYPES.includes(docType)) {
      throw BizError.invalid(`doc_type 非法（可用：${DOC_TYPES.join(', ')}）`);
    }
    const res = this.db.run(
      `INSERT INTO documents(user_id, doc_type, file_name, file_key, mime, file_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      userId,
      docType,
      fileName,
      fileKey,
      String(body?.mime || ''),
      Number(body?.file_size || 0),
      new Date().toISOString(),
    );
    return this.db.get<DocumentRow>('SELECT * FROM documents WHERE id = ?', Number(res.lastInsertRowid));
  }

  list(userId: number, docType?: string) {
    const rows = docType
      ? this.db.all<DocumentRow>(
          'SELECT * FROM documents WHERE user_id = ? AND doc_type = ? ORDER BY id DESC',
          userId, docType,
        )
      : this.db.all<DocumentRow>('SELECT * FROM documents WHERE user_id = ? ORDER BY id DESC', userId);
    return { total: rows.length, items: rows };
  }

  async remove(userId: number, id: number) {
    // 取 file_key 而非仅 id：删记录后还要清理存储对象
    const row = this.db.get<DocumentRow>(
      'SELECT * FROM documents WHERE id = ? AND user_id = ?',
      id, userId,
    );
    if (!row) throw BizError.notFound('材料不存在');
    this.db.run('DELETE FROM documents WHERE id = ? AND user_id = ?', id, userId);
    // 尽力而为地清理存储对象：记录已删但文件残留是可接受的（可离线回收），
    // 反过来（文件删了记录还在）才会让用户看到打不开的材料，故顺序不可颠倒
    const cleaned = await this.storage.remove(row.file_key);
    return { ok: true, id, storage_cleaned: cleaned };
  }

  // ------------------------------------------------------------ 简历
  parseResume(userId: number, body: any) {
    const text = String(body?.text || body?.content || '').trim();
    if (!text) throw BizError.invalid('缺少 text（简历纯文本）');
    if (text.length > 200_000) throw BizError.invalid('简历文本过长');

    const parsed = parseResumeText(text);
    const now = new Date().toISOString();
    const prev = this.db.get<{ v: number }>(
      'SELECT COALESCE(MAX(version), 0) AS v FROM resumes WHERE user_id = ?',
      userId,
    );
    const version = (prev?.v || 0) + 1;
    const res = this.db.run(
      `INSERT INTO resumes(user_id, name, source_text, parsed, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      userId,
      String(body?.name || `简历 v${version}`),
      text,
      JSON.stringify(parsed),
      version,
      now,
      now,
    );
    return this.getResume(userId, Number(res.lastInsertRowid));
  }

  listResumes(userId: number) {
    const rows = this.db.all<ResumeRow>(
      'SELECT * FROM resumes WHERE user_id = ? ORDER BY version DESC',
      userId,
    );
    return {
      total: rows.length,
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        version: r.version,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    };
  }

  getResume(userId: number, id: number) {
    const row = this.db.get<ResumeRow>(
      'SELECT * FROM resumes WHERE id = ? AND user_id = ?',
      id, userId,
    );
    if (!row) throw BizError.notFound('简历不存在');
    let parsed: any = {};
    try {
      parsed = JSON.parse(row.parsed);
    } catch {
      parsed = {};
    }
    return { id: row.id, name: row.name, version: row.version, parsed, updated_at: row.updated_at };
  }

  updateResume(userId: number, id: number, body: any) {
    const row = this.db.get<ResumeRow>(
      'SELECT * FROM resumes WHERE id = ? AND user_id = ?',
      id, userId,
    );
    if (!row) throw BizError.notFound('简历不存在');
    const sets: string[] = [];
    const params: any[] = [];
    if (body?.name !== undefined) {
      sets.push('name = ?');
      params.push(String(body.name));
    }
    if (body?.parsed !== undefined) {
      if (typeof body.parsed !== 'object' || body.parsed === null) {
        throw BizError.invalid('parsed 必须是 JSON 对象');
      }
      sets.push('parsed = ?');
      params.push(JSON.stringify(body.parsed));
    }
    if (body?.text !== undefined) {
      sets.push('source_text = ?');
      params.push(String(body.text));
    }
    if (!sets.length) throw BizError.invalid('没有可更新的字段');
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id, userId);
    this.db.run(`UPDATE resumes SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, ...params);
    return this.getResume(userId, id);
  }
}

export { DOC_TYPES, MAX_FILE_SIZE };
