import * as net from 'node:net'
import { getAtomSpace } from './atomspace'
import { dumpAtomese } from './atomese'

/**
 * CogServer client — direct TCP federation with a running OpenCog CogServer.
 *
 * The CogServer exposes the AtomSpace on the network (default port 17001) behind
 * a Scheme (guile) shell. This client enters that shell and issues Atomese/Scheme
 * commands, so HellGraph can push its metagraph into a remote AtomSpace, pull
 * results back, and trigger native Pattern Matcher / PLN execution — the same
 * channel a `CogStorageNode` uses to federate AtomSpaces.
 *
 * This is the no-sidecar path: useful when an OpenCog CogServer is already
 * running. For embedded reasoning, prefer the HTTP sidecar (sidecar.ts).
 */

export interface CogServerOptions {
  host?: string
  port?: number
  /** Command that enters the Scheme shell. Default 'scm hush' to suppress echo. */
  enterShell?: string
  timeoutMs?: number
}

export class CogServerClient {
  private socket: net.Socket | null = null
  private readonly host: string
  private readonly port: number
  private readonly enterShell: string
  private readonly timeoutMs: number
  // The guile shell prompt that signals end-of-response.
  private static readonly PROMPT = /guile>\s*$/

  constructor(opts: CogServerOptions = {}) {
    this.host = opts.host ?? process.env.COGSERVER_HOST ?? '127.0.0.1'
    this.port = opts.port ?? Number(process.env.COGSERVER_PORT ?? 17001)
    this.enterShell = opts.enterShell ?? 'scm hush'
    this.timeoutMs = opts.timeoutMs ?? 15_000
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this.socket = socket
        // Enter the Scheme shell; swallow the banner.
        socket.write(`${this.enterShell}\n`)
        setTimeout(resolve, 250)
      })
      socket.setEncoding('utf-8')
      socket.once('error', reject)
      socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('CogServer connection timed out')))
    })
  }

  /** Send a Scheme/Atomese command and resolve with the textual response. */
  send(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = this.socket
      if (!socket) return reject(new Error('CogServer client not connected'))

      let buffer = ''
      const onData = (chunk: string) => {
        buffer += chunk
        if (CogServerClient.PROMPT.test(buffer)) {
          socket.off('data', onData)
          clearTimeout(timer)
          resolve(buffer.replace(CogServerClient.PROMPT, '').trim())
        }
      }
      const timer = setTimeout(() => {
        socket.off('data', onData)
        // Return whatever we have — some commands produce no prompt-terminated output.
        resolve(buffer.trim())
      }, this.timeoutMs)

      socket.on('data', onData)
      socket.write(`${command}\n`)
    })
  }

  async close(): Promise<void> {
    if (!this.socket) return
    try { this.socket.write('.\n') } catch { /* ignore */ }
    this.socket.end()
    this.socket = null
  }
}

/** Push the local HellGraph metagraph into a remote CogServer's AtomSpace. */
export async function pushToCogServer(opts: CogServerOptions = {}): Promise<{ ok: boolean; bytes: number }> {
  const atomese = dumpAtomese(getAtomSpace())
  const client = new CogServerClient(opts)
  await client.connect()
  try {
    // Evaluate the whole dump as one begin-form so all atoms are defined.
    await client.send(`(begin ${atomese} )`)
    return { ok: true, bytes: atomese.length }
  } finally {
    await client.close()
  }
}

/** Run a BindLink/GetLink on the remote CogServer's Pattern Matcher. */
export async function executeOnCogServer(bindlink: string, opts: CogServerOptions = {}): Promise<string> {
  const client = new CogServerClient(opts)
  await client.connect()
  try {
    return await client.send(`(cog-execute! ${bindlink})`)
  } finally {
    await client.close()
  }
}
