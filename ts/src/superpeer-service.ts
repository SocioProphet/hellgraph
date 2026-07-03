/**
 * Deployable super-peer entrypoint — the cloud twin runs THIS to become a live, read-replica
 * federation participant instead of restoring a periodic RocksDB blob.
 *
 * The twin bootstraps from the EDGE's federation base key (HELLGRAPH_BOOTSTRAP_KEY), joins the
 * swarm, replicates the edge's sovereign Hypercore log, and serves the causally-merged view over
 * the SuperPeer HTTP surface (/health /cut /query /admit). Because the twin is NEVER admitted as a
 * writer, it is structurally a replica/index — it cannot forge or rewrite, so there is no
 * split-brain: the edge stays sole authority and the twin converges via Autobase causal merge.
 *
 * Env:
 *   HELLGRAPH_STORAGE_DIR   corestore dir (default /var/lib/hellgraph-superpeer)
 *   HELLGRAPH_BOOTSTRAP_KEY  edge federation base key (hex). Omit → this node is the creator.
 *   HELLGRAPH_HTTP_PORT      HTTP port (default 8850)
 *   HELLGRAPH_JOIN_SWARM     "0" to skip Hyperswarm (e.g. direct-replication/tests)
 */
import { SuperPeer } from './super-peer.js'

export interface SuperPeerServiceEnv {
  HELLGRAPH_STORAGE_DIR?: string
  HELLGRAPH_BOOTSTRAP_KEY?: string
  HELLGRAPH_HTTP_PORT?: string
  HELLGRAPH_JOIN_SWARM?: string
}

export interface RunningSuperPeer {
  superPeer: SuperPeer
  port: number
  baseKey: string
}

/** Create + start a super-peer from environment config. Returns the running instance. */
export async function startSuperPeerFromEnv(env: SuperPeerServiceEnv = process.env): Promise<RunningSuperPeer> {
  const dir = env.HELLGRAPH_STORAGE_DIR ?? '/var/lib/hellgraph-superpeer'
  const bootstrap = env.HELLGRAPH_BOOTSTRAP_KEY?.trim() || undefined
  const port = Number(env.HELLGRAPH_HTTP_PORT ?? '8850')

  const superPeer = await SuperPeer.create(dir, bootstrap ? { bootstrap } : {})

  if (env.HELLGRAPH_JOIN_SWARM !== '0') {
    try {
      await superPeer.joinSwarm()
    } catch (e) {
      // Hyperswarm is an optional dependency; without it the node still serves + replicates
      // over any transport wired directly (e.g. a sidecar). Don't crash the pod.
      console.warn(`[superpeer] joinSwarm skipped: ${(e as Error).message}`)
    }
  }

  const bound = await superPeer.listen(port)
  console.log(
    `[superpeer] role=${bootstrap ? 'twin-replica' : 'creator'} base=${superPeer.baseKey()} ` +
      `listening :${bound}`,
  )
  return { superPeer, port: bound, baseKey: superPeer.baseKey() }
}
