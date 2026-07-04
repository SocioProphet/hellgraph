#!/usr/bin/env node
/**
 * Container entrypoint for the HellGraph super-peer.
 *
 * Boots the deployable super-peer from environment config (see superpeer-service.ts) and
 * drains cleanly on SIGTERM/SIGINT so Kubernetes pod termination doesn't drop connections or
 * corrupt the corestore. Imports the built package, so `npm run build` must have run.
 *
 * Env (see also deploy/k8s/superpeer.yaml):
 *   HELLGRAPH_STORAGE_DIR    corestore dir (mount a PVC here)   default /var/lib/hellgraph-superpeer
 *   HELLGRAPH_BOOTSTRAP_KEY  edge federation base key (hex); omit → this node is the creator
 *   HELLGRAPH_HTTP_PORT      HTTP port                          default 8850
 *   HELLGRAPH_JOIN_SWARM     "0" to skip Hyperswarm discovery
 *   HELLGRAPH_AUTH_SECRET    HMAC secret for bearer auth; unset → endpoints OPEN (dev only)
 */
import { startSuperPeerFromEnv } from '../ts/dist/index.mjs'

const running = await startSuperPeerFromEnv()

let closing = false
const shutdown = async (sig) => {
  if (closing) return
  closing = true
  console.log(`[superpeer] ${sig} → draining and closing`)
  try {
    await running.superPeer.close()
  } catch (err) {
    console.error('[superpeer] close error:', err)
  } finally {
    process.exit(0)
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
