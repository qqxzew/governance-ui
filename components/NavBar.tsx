import useQueryContext from '@hooks/useQueryContext'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import ThemeSwitch from './ThemeSwitch'
import { ExternalLinkIcon } from '@heroicons/react/outline'
import DialectNotifications from './Dialect'
import {
  APP_SHORT_NAME,
  APP_TAGLINE,
  FORK_REPO_URL,
} from '@constants/branding'

const ConnectWalletButtonDynamic = dynamic(
  async () => await import('./ConnectWalletButton'),
  { ssr: false },
)

const NavBar = () => {
  const { fmtUrlWithCluster } = useQueryContext()

  return (
    <div className="flex flex-col sm:grid sm:grid-cols-12 relative z-20">
      <div className="flex items-center justify-between h-20 col-span-12 px-4 xl:col-start-2 xl:col-span-10 md:px-8 xl:px-4">
        <div className="flex gap-2 sm:gap-8 items-center relative">
          <Link href={fmtUrlWithCluster('/realms')}>
            {/* Fork logo: shield mark + wordmark (this fork does not use the Realms logo). */}
            <div className="flex cursor-pointer items-center gap-2.5 whitespace-nowrap">
              <svg
                width="30"
                height="30"
                viewBox="0 0 32 32"
                aria-hidden="true"
                className="shrink-0"
              >
                <path
                  d="M16 2.5 4.5 7v8.2c0 7.1 4.9 12.6 11.5 14.3 6.6-1.7 11.5-7.2 11.5-14.3V7L16 2.5Z"
                  fill="var(--primary-light)"
                  fillOpacity="0.14"
                  stroke="var(--primary-light)"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
                <path
                  d="m10.8 16.2 3.6 3.6 7-7.4"
                  fill="none"
                  stroke="var(--primary-light)"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <div className="flex flex-col leading-tight">
                <span className="text-base sm:text-lg font-bold text-fgd-1 tracking-tight">
                  {APP_SHORT_NAME}
                </span>
                <span className="hidden sm:block text-[11px] uppercase tracking-[0.14em] text-primary-light">
                  {APP_TAGLINE}
                </span>
              </div>
            </div>
          </Link>
        </div>
        <div className="flex items-center justify-end space-x-2 md:space-x-4">
          <a
            className="border-b border-transparent items-center cursor-pointer -mb-[1px] transition-colors hidden sm:flex hover:border-primary-light"
            href={FORK_REPO_URL}
            target="_blank"
            rel="noreferrer"
          >
            <div className="text-fgd-2 text-sm">Source</div>
            <ExternalLinkIcon className="stroke-fgd-2 h-4 w-4 ml-2" />
          </a>
          <ThemeSwitch />
          <DialectNotifications />
          <ConnectWalletButtonDynamic />
        </div>
      </div>
    </div>
  )
}

export default NavBar
