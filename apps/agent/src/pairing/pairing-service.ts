import { randomBase64Url, sha256Base64Url, TOKEN_BYTES } from '../security/random.js';
import { DeviceStore } from '../store/device-store.js';

/** 配对二维码与配对请求的有效期。 */
export const PAIRING_TTL_MS = 5 * 60 * 1000;

/** 单个配对请求允许的失败次数。 */
const MAX_FAILURES_PER_PAIRING = 5;

/** Agent 级全局限流窗口与上限。 */
const GLOBAL_WINDOW_MS = 60 * 1000;
const GLOBAL_MAX_ATTEMPTS = 10;

const PAIRING_ID_BYTES = 12;
const DEVICE_ID_BYTES = 12;

/** 终端二维码内容；只含一次性配对信息。 */
export interface PairingQrPayload {
  v: 1;
  baseUrl: string;
  pairingId: string;
  code: string;
  expiresAt: number;
}

/** App 提交的配对请求；不含来源 IP 或代理头。 */
export interface PairingInput {
  pairingId: string;
  code: string;
  deviceName: string;
  appVersion: string;
  supportedProtocolVersions: number[];
}

/** 配对成功的结果；deviceToken 只在此处出现一次。 */
export interface PairingResult {
  deviceId: string;
  deviceToken: string;
  desktopId: string;
  protocolVersion: 1;
}

/** 配对失败的稳定错误码。 */
export type PairingErrorCode =
  | 'PAIRING_FAILED'
  | 'PAIRING_EXPIRED'
  | 'DEVICE_ALREADY_PAIRED'
  | 'RATE_LIMITED'
  | 'VERSION_INCOMPATIBLE';

/** 配对失败；调用方只依赖 code。 */
export class PairingError extends Error {
  constructor(readonly code: PairingErrorCode, message: string = code) {
    super(message);
    this.name = 'PairingError';
  }
}

/** 构造配对服务的依赖。 */
export interface PairingServiceOptions {
  deviceStore: DeviceStore;
  desktopId: string;
  baseUrl: string;
  now?: () => number;
}

interface PendingPairing {
  pairingId: string;
  code: string;
  expiresAt: number;
  replace: boolean;
  failures: number;
}

/** 一次性配对：内存保存单个 pending 请求，成功后只落盘令牌哈希。 */
export class PairingService {
  private readonly deviceStore: DeviceStore;
  private readonly desktopId: string;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private pending: PendingPairing | null = null;
  private attempts: number[] = [];

  constructor(options: PairingServiceOptions) {
    this.deviceStore = options.deviceStore;
    this.desktopId = options.desktopId;
    this.baseUrl = options.baseUrl;
    this.now = options.now ?? (() => Date.now());
  }

  /** 生成本机终端展示的二维码载荷；已有设备时需显式 replace。 */
  begin(replace: boolean = false): PairingQrPayload {
    if (!replace && this.deviceStore.active() !== null) {
      throw new PairingError(
        'DEVICE_ALREADY_PAIRED',
        'a device is already paired; use pair --replace',
      );
    }
    const pairingId = `pair_${randomBase64Url(PAIRING_ID_BYTES)}`;
    const code = randomBase64Url(TOKEN_BYTES);
    const expiresAt = this.now() + PAIRING_TTL_MS;
    this.pending = { pairingId, code, expiresAt, replace, failures: 0 };
    return { v: 1, baseUrl: this.baseUrl, pairingId, code, expiresAt };
  }

  /** 原子消费配对请求；成功后签发一次性 deviceToken。 */
  async consume(input: PairingInput): Promise<PairingResult> {
    this.recordAttempt();

    if (!input.supportedProtocolVersions.includes(1)) {
      throw new PairingError(
        'VERSION_INCOMPATIBLE',
        'no common protocol version',
      );
    }

    const pending = this.pending;
    if (pending === null || pending.pairingId !== input.pairingId) {
      throw new PairingError('PAIRING_FAILED', 'pairing request not found');
    }
    if (this.now() >= pending.expiresAt) {
      this.pending = null;
      throw new PairingError('PAIRING_EXPIRED', 'pairing request expired');
    }
    if (pending.code !== input.code) {
      pending.failures += 1;
      if (pending.failures >= MAX_FAILURES_PER_PAIRING) {
        this.pending = null;
      }
      throw new PairingError('PAIRING_FAILED', 'pairing request rejected');
    }

    this.pending = null;
    const active = this.deviceStore.active();
    if (active !== null) {
      if (!pending.replace) {
        throw new PairingError(
          'DEVICE_ALREADY_PAIRED',
          'a device is already paired',
        );
      }
      await this.deviceStore.revoke(active.deviceId);
    }

    const deviceId = `device_${randomBase64Url(DEVICE_ID_BYTES)}`;
    const deviceToken = randomBase64Url(TOKEN_BYTES);
    await this.deviceStore.create(
      deviceId,
      input.deviceName,
      sha256Base64Url(deviceToken),
    );
    return {
      deviceId,
      deviceToken,
      desktopId: this.desktopId,
      protocolVersion: 1,
    };
  }

  private recordAttempt(): void {
    const now = this.now();
    this.attempts = this.attempts.filter(
      (attempt) => now - attempt < GLOBAL_WINDOW_MS,
    );
    if (this.attempts.length >= GLOBAL_MAX_ATTEMPTS) {
      throw new PairingError('RATE_LIMITED', 'too many pairing attempts');
    }
    this.attempts.push(now);
  }
}