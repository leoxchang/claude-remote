import { describe, expect, it } from 'vitest';

import {
  checkTailscaleServe,
  ExecFile,
} from '../src/transport/tailscale-preflight.js';

const execReturning = (stdout: string): ExecFile => async () => ({
  stdout,
  stderr: '',
});

const serveStatus = (funnel: boolean): string =>
  JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Web: {
      'macbook.example-tailnet.ts.net:443': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } },
      },
    },
    AllowFunnel: { 'macbook.example-tailnet.ts.net:443': funnel },
  });

describe('checkTailscaleServe', () => {
  it('reports https and the host without funnel', async () => {
    const status = await checkTailscaleServe(execReturning(serveStatus(false)));

    expect(status).toEqual({
      https: true,
      funnel: false,
      host: 'macbook.example-tailnet.ts.net',
    });
  });

  it('fails when funnel is enabled', async () => {
    await expect(
      checkTailscaleServe(execReturning(serveStatus(true))),
    ).rejects.toThrow(/funnel/i);
  });

  it('reports https false when no serve handler exists', async () => {
    const status = await checkTailscaleServe(execReturning('{}'));

    expect(status).toEqual({ https: false, funnel: false, host: '' });
  });

  it('fails when the command output is not json', async () => {
    await expect(
      checkTailscaleServe(execReturning('not json')),
    ).rejects.toThrow(/json/i);
  });
});