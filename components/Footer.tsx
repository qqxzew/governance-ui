import cx from 'classnames'
import { ExternalLinkIcon } from '@heroicons/react/outline'

import SocialIcons from '@components/SocialIcons'
import { useEffect, useState } from 'react'
import {
  APP_NAME,
  UPSTREAM_ATTRIBUTION,
  UPSTREAM_REPO_URL,
} from '@constants/branding'

const Footer = () => {
  const { REALM } = process.env
  const [usingRealmFromProcessEnv, setUsingRealmFromProcessEnv] =
    useState(false)

  useEffect(() => {
    setUsingRealmFromProcessEnv(!!REALM)
  }, [REALM])

  if (usingRealmFromProcessEnv) {
    return null
  }

  return (
    <div
      className={cx(
        'absolute',
        'bottom-0',
        'left-0',
        'flex',
        'flex-row',
        'items-center',
        'justify-around',
        'w-full',
        'h-20',
        'pb-0',
        'lg:pb-24',
        'gap-y-8',
        'md:gap-y-0',
        'z-[1]',
      )}
    >
      <div
        className={cx(
          'absolute',
          'flex-col',
          'flex',
          'gap-1',
          'sm:gap-2',
          'items-center',
          'justify-center',
          'left-1/2',
          'pb-4',
          'top-1/2',
          '-translate-x-1/2',
          'translate-y-[20px]',
          'lg:relative',
          'lg:pb-0',
          'lg:translate-x-0',
          'lg:translate-y-0',
          'lg:left-0',
          'lg:top-0',
          'w-fit',
        )}
      >
        <div
          className={cx('flex', 'flex-col', 'items-center', 'justify-center')}
        >
          <SocialIcons className="mb-5" />
          <div className="flex flex-col justify-center sm:space-x-2 text-center text-sm opacity-70 sm:flex-row sm:text-sm sm:text-left">
            <div className="flex-shrink-0">{APP_NAME}</div>
            <span className="hidden sm:block mx-2">|</span>
            <a
              className="flex-shrink-0 whitespace-nowrap"
              href={UPSTREAM_REPO_URL}
              target="_blank"
              rel="noreferrer"
            >
              {UPSTREAM_ATTRIBUTION}
            </a>
          </div>
        </div>

        <a
          className={cx(
            'flex',
            'items-center',
            'group',
            'opacity-70',
            'active:opacity-50',
            'focus:opacity-[.80]',
            'hover:opacity-[.80]',
            'mr-2',
            'text-sm',
          )}
          href="https://docs.realms.today/"
        >
          <ExternalLinkIcon className="w-4 h-4 mr-2 stroke-current" />
          <div>Read the Docs</div>
        </a>

        <div className="opacity-70">
          Powered by <span className="font-bold">Solana</span>
        </div>
      </div>
    </div>
  )
}

export default Footer
