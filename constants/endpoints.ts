// A same-origin path such as "/api/rpc" (public deployments: the server proxies to the real RPC
// so the API key never reaches the browser) is resolved against the current origin; web3.js
// Connection needs an absolute URL.
const resolveEndpoint = (url: string) => {
  if (!url.startsWith('/')) return url
  if (typeof window !== 'undefined') return window.location.origin + url
  return `http://localhost:${process.env.PORT || 3000}${url}`
}

export const MAINNET_RPC = resolveEndpoint(
  process.env.NEXT_PUBLIC_MAINNET_RPC ||
    process.env.MAINNET_RPC ||
    'http://realms-realms-c335.mainnet.rpcpool.com',
)

export const DEVNET_RPC = resolveEndpoint(
  process.env.NEXT_PUBLIC_DEVNET_RPC ||
    process.env.DEVNET_RPC ||
    'https://mango.devnet.rpcpool.com',
)
