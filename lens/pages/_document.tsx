import { Head, Html, Main, NextScript } from 'next/document'

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap"
        />
        <meta name="theme-color" content="#0a0b0d" />
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect width='24' height='24' rx='6' fill='%230a0b0d'/><path d='M12 20s6.5-3.2 6.5-8V6.5L12 4 5.5 6.5V12c0 4.8 6.5 8 6.5 8z' fill='none' stroke='%232dd4a7' stroke-width='1.8'/><path d='m9.3 12 1.9 1.9 3.6-3.8' fill='none' stroke='%232dd4a7' stroke-width='2' stroke-linecap='round'/></svg>"
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}
