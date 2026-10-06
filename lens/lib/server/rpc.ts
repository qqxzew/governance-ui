// Server-side Solana connection. The upstream URL (with its API key) comes only from
// RPC_UPSTREAM and is never sent to the browser or written to logs.
import { Connection } from '@solana/web3.js'
import { makeConnection } from '../../../bots/telegram/rpc'
import { rpcUpstream } from './env'

let conn: Connection | undefined

export function getConnection(): Connection {
  if (conn) return conn
  const url = rpcUpstream()
  if (!url) throw new Error('RPC_UPSTREAM is not configured on the server')
  conn = makeConnection(url, { maxRetries: 6 })
  return conn
}

/** Never leak the upstream URL in error messages. */
export function safeError(e: unknown): string {
  const msg = String((e as Error)?.message ?? e)
  return msg.replace(/https?:\/\/[^\s"']+/g, '<rpc>').slice(0, 300)
}
