import { AddressInfo } from 'node:net';

import { createRelayApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
const app = await createRelayApp({ logger: true });
await app.listen({ host: config.host, port: config.port });

const address = app.server.address();
const port = address === null ? config.port : (address as AddressInfo).port;
process.stdout.write(
  `${JSON.stringify({ event: 'relay.started', host: config.host, port })}\n`,
);