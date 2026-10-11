/**
 * 对象存储抽象（契约 §3 documents）。
 *
 * 目标：把「预签名上传」从 PoC 占位变成**真实可用**，同时保留切到 S3/MinIO 的位置。
 *
 *   * `local`（默认）：落盘到 `STORAGE_DIR`（默认 `./storage`），零依赖、单机与 PoC 真实可用
 *   * `s3`：尚未接入（需要 SDK 与凭据），显式配置为 s3 时**快速失败**，
 *          不做「假装成功」的静默降级——否则会出现「登记了但文件不存在」的坏数据
 *
 * 安全：`resolveObjectPath` 做路径穿越防护（`..`、绝对路径、控制字符一律拒绝），
 * 因为 file_key 来自请求体，属于不可信输入。
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export interface PutResult {
  key: string;
  size: number;
  /** 驱动自定义的存储位置（本地为绝对路径） */
  location: string;
}

export interface StorageDriver {
  readonly name: string;
  put(key: string, bytes: Buffer, contentType?: string): Promise<PutResult>;
  /** 该对象的访问 URL（本地驱动为网关自身的回读端点） */
  url(key: string): string;
  remove(key: string): Promise<boolean>;
  exists(key: string): boolean;
  /** 回读对象内容（下载 / 预览） */
  read(key: string): Buffer;
}

/** 允许的 key 字符：字母数字、点、斜杠、下划线、短横线、中文等常见字符，不含 `..` 与分隔符开头 */
const KEY_RE = /^[A-Za-z0-9._\-\u4e00-\u9fa5]+(?:\/[A-Za-z0-9._\-\u4e00-\u9fa5]+)*$/;

/**
 * 校验并解析对象在磁盘上的真实路径（纯函数，可直接测试）。
 * 非法 key 抛错——不做「清洗后放行」，避免 `..%2f..` 之类变形绕过。
 */
export function resolveObjectPath(rootDir: string, key: string): string {
  if (typeof key !== 'string' || !key.trim()) throw new Error('file_key 为空');
  const k = key.trim();
  if (k.length > 512) throw new Error('file_key 过长');
  if (!KEY_RE.test(k)) throw new Error('file_key 含非法字符');
  if (k.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    throw new Error('file_key 含非法路径段');
  }
  const root = resolve(rootDir);
  const full = resolve(join(root, k));
  // 双重保险：解析后必须仍在根目录之内
  if (full !== root && !full.startsWith(root + sep)) throw new Error('file_key 越出存储根目录');
  return full;
}

/** 本地磁盘驱动：PoC 与单机部署真实可用 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';
  readonly rootDir: string;

  constructor(opts: { rootDir?: string; publicBase?: string } = {}) {
    this.rootDir = resolve(opts.rootDir || process.env.STORAGE_DIR || './storage');
    this.publicBase = opts.publicBase || process.env.STORAGE_PUBLIC_BASE || '';
    mkdirSync(this.rootDir, { recursive: true });
  }

  private readonly publicBase: string;

  async put(key: string, bytes: Buffer): Promise<PutResult> {
    const full = resolveObjectPath(this.rootDir, key);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    return { key, size: bytes.length, location: full };
  }

  /** 上传端点：客户端拿 presign 返回的 URL 直接 PUT 到这里 */
  url(key: string): string {
    const base = this.publicBase.replace(/\/$/, '');
    return `${base}/api/v1/documents/upload/${encodeURI(key)}`;
  }

  async remove(key: string): Promise<boolean> {
    try {
      const full = resolveObjectPath(this.rootDir, key);
      if (!existsSync(full)) return false;
      unlinkSync(full);
      return true;
    } catch {
      return false;
    }
  }

  exists(key: string): boolean {
    try {
      return existsSync(resolveObjectPath(this.rootDir, key));
    } catch {
      return false;
    }
  }

  read(key: string): Buffer {
    return readFileSync(resolveObjectPath(this.rootDir, key));
  }
}

/**
 * S3 / MinIO 驱动占位。
 * 显式保留而非省略：让「未接入」这件事在代码里是显式的、可发现的，
 * 而不是藏在 if 分支里变成静默降级。
 */
export class S3StorageDriver implements StorageDriver {
  readonly name = 's3';

  constructor() {
    throw new Error(
      'S3 驱动尚未接入：需要 @aws-sdk/client-s3 与 STORAGE_S3_* 配置。'
      + '当前请使用 STORAGE_DRIVER=local（默认）',
    );
  }

  async put(): Promise<PutResult> {
    throw new Error('S3 驱动未接入');
  }

  url(): string {
    throw new Error('S3 驱动未接入');
  }

  async remove(): Promise<boolean> {
    throw new Error('S3 驱动未接入');
  }

  exists(): boolean {
    throw new Error('S3 驱动未接入');
  }

  read(): Buffer {
    throw new Error('S3 驱动未接入');
  }
}

/** 按 `STORAGE_DRIVER` 解析驱动（默认 local） */
export function resolveStorageDriver(
  raw = process.env.STORAGE_DRIVER,
  opts: { rootDir?: string; publicBase?: string } = {},
): StorageDriver {
  const name = String(raw || 'local').trim().toLowerCase();
  if (name === 'local') return new LocalStorageDriver(opts);
  if (name === 's3' || name === 'minio') return new S3StorageDriver();
  throw new Error(`未知的 STORAGE_DRIVER：${name}（可选 local / s3）`);
}
