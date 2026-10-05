import {
  APP_NAME,
  EVALUATION_NOTICE,
  READ_ONLY_MAINNET_NOTICE,
  UPSTREAM_ATTRIBUTION,
  UPSTREAM_REPO_URL,
} from '@constants/branding'
import { READ_ONLY_MAINNET } from '@utils/readOnlyMainnet'

/** Persistent top banner: project status + upstream attribution. Not dismissible. */
const EvaluationBanner = () => (
  <div
    role="note"
    className="relative z-30 w-full border-b border-amber-500/40 bg-amber-500/15 px-4 py-1.5 text-center text-xs text-amber-200 sm:text-sm"
  >
    <span className="font-semibold">{APP_NAME}</span>
    <span className="mx-2 opacity-60">·</span>
    <span>
      {EVALUATION_NOTICE}
      {READ_ONLY_MAINNET ? ` ${READ_ONLY_MAINNET_NOTICE}` : ''}
    </span>
    <span className="mx-2 hidden opacity-60 sm:inline">·</span>
    <a
      className="block underline opacity-80 hover:opacity-100 sm:inline"
      href={UPSTREAM_REPO_URL}
      target="_blank"
      rel="noreferrer"
    >
      {UPSTREAM_ATTRIBUTION}
    </a>
  </div>
)

export default EvaluationBanner
