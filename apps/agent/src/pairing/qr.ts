import QRCode from 'qrcode';

import { PairingQrPayload } from './pairing-service.js';

/** 把一次性配对载荷渲染为终端二维码；不包含任何长期凭证。 */
export async function renderPairingQr(
  payload: PairingQrPayload,
): Promise<string> {
  return QRCode.toString(JSON.stringify(payload), {
    type: 'terminal',
    small: true,
  });
}