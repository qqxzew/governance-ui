import type { AppProps } from 'next/app'
import Head from 'next/head'
import '../styles/globals.css'

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Open Realms — know what you vote for</title>
        <meta
          name="description"
          content="Every SPL Governance proposal, decoded into plain language, with red flags for what the description doesn't tell you."
        />
      </Head>
      <Component {...pageProps} />
    </>
  )
}
