#!/usr/bin/env node
// Deployable super-peer entrypoint. The cloud twin runs this to join the edge federation
// (HELLGRAPH_BOOTSTRAP_KEY) as a read-replica and serve the merged view over HTTP.
import { startSuperPeerFromEnv } from '../ts/dist/index.mjs'
startSuperPeerFromEnv().catch((e) => { console.error(e); process.exit(1) })
