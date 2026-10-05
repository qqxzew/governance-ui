// Demo safety switch: with NEXT_PUBLIC_READ_ONLY_MAINNET=true the app refuses
// to sign or send transactions on anything that is not devnet/localnet.
//
// Two layers, both central:
//  1. assertWritableConnection(connection) at the top of the shared sign/send
//     helpers (utils/send.tsx, utils/sendTransactions.tsx,
//     utils/modifiedMangolana.ts) -> fails BEFORE the wallet popup.
//  2. installReadOnlyMainnetGuard() patches web3.js Connection send methods
//     (sendRawTransaction / sendEncodedTransaction / sendTransaction), so any
//     code path that signs on its own still cannot submit to mainnet.
// Fail closed: an endpoint counts as writable only if it is the configured
// devnet RPC, a devnet/testnet URL, or the local validator (127.0.0.1:8899).
import { Connection } from '@solana/web3.js'
import { DEVNET_RPC, MAINNET_RPC } from '@constants/endpoints'

export const READ_ONLY_MAINNET =
  process.env.NEXT_PUBLIC_READ_ONLY_MAINNET === 'true'

export const READ_ONLY_MAINNET_ERROR =
  'Mainnet is read-only in this demo build; switch to devnet'

export class ReadOnlyMainnetError extends Error {
  constructor() {
    super(READ_ONLY_MAINNET_ERROR)
    this.name = 'ReadOnlyMainnetError'
  }
}

const LOCAL_VALIDATORS = ['http://127.0.0.1:8899', 'http://localhost:8899']

export function isWritableEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return false
  const e = endpoint.replace(/\/+$/, '')
  if (e === MAINNET_RPC.replace(/\/+$/, '')) return false
  if (e === DEVNET_RPC.replace(/\/+$/, '')) return true
  if (LOCAL_VALIDATORS.includes(e)) return true
  try {
    const host = new URL(e).hostname
    return /(^|[.-])(devnet|testnet)([.-]|$)/i.test(host)
  } catch {
    return false
  }
}

export function isReadOnlyConnection(connection?: {
  rpcEndpoint?: string
}): boolean {
  return READ_ONLY_MAINNET && !isWritableEndpoint(connection?.rpcEndpoint)
}

export function assertWritableConnection(connection?: {
  rpcEndpoint?: string
}) {
  if (isReadOnlyConnection(connection)) throw new ReadOnlyMainnetError()
}

let installed = false

export function installReadOnlyMainnetGuard() {
  if (!READ_ONLY_MAINNET || installed) return
  installed = true
  const proto = Connection.prototype as any
  for (const name of [
    'sendRawTransaction',
    'sendEncodedTransaction',
    'sendTransaction',
  ]) {
    const original = proto[name]
    if (typeof original !== 'function') continue
    proto[name] = function (this: Connection, ...args: any[]) {
      if (isReadOnlyConnection(this)) {
        return Promise.reject(new ReadOnlyMainnetError())
      }
      return original.apply(this, args)
    }
  }
}
