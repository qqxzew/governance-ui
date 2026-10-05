import { useRouter } from 'next/router'
import Footer from '@components/Footer'
import { PluginDebug } from '../VoterWeightPlugins/lib/PluginDebug'
import React from 'react'

const PageBodyContainer = ({ children }) => {
  const { pathname, query } = useRouter()
  const isNewRealmsWizard = /\/realms\/new\/\w+/.test(pathname)

  // TODO TEMP DEBUG - REMOVE BEFORE MERGE
  if (query['debug'] !== undefined) {
    return <PluginDebug />
  }

  return (
    <>
      <div
        className={`grid grid-cols-12 gap-4 pt-4 ${
          isNewRealmsWizard ? '' : 'min-h-[calc(100vh_-_80px)] pb-12 sm:pb-64'
        }`}
      >
        {/* Fork background: CSS glow + faint grid instead of upstream's image */}
        <div
          className="z-[1] fixed top-0 left-0 w-[100vw] h-[100vh] bg-bkg-1"
          style={{
            backgroundImage:
              'radial-gradient(60rem 30rem at 85% -10%, rgba(62,230,176,0.10), transparent 60%),' +
              'radial-gradient(40rem 25rem at -10% 110%, rgba(62,160,230,0.08), transparent 60%),' +
              'linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),' +
              'linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)',
            backgroundSize: 'auto, auto, 48px 48px, 48px 48px',
          }}
        />
        <div className="relative z-[2] col-span-12 px-4 md:px-8 xl:px-4 xl:col-start-2 xl:col-span-10">
          {children}
        </div>
      </div>
      {isNewRealmsWizard ? <></> : <Footer />}
    </>
  )
}

export default PageBodyContainer
