/* eslint-disable @typescript-eslint/no-var-requires */
// Open Realms "lens": the fast, read-only voter front door. Reuses the fork's
// safety engine (../tools/proposalSafety) and VSR math (../tools/vsr) on the server;
// the browser only receives finished JSON.
module.exports = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: { externalDir: true },
  // Types are checked by the root `tsc` (it includes lens/); keep builds fast.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  env: {
    NEXT_PUBLIC_FULL_UI_URL: process.env.NEXT_PUBLIC_FULL_UI_URL || '',
    NEXT_PUBLIC_SOURCE_URL:
      process.env.NEXT_PUBLIC_SOURCE_URL || 'https://github.com/qqxzew/governance-ui',
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false }
    }
    return config
  },
}
