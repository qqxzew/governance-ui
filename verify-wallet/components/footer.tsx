import {
  APP_NAME,
  UPSTREAM_ATTRIBUTION,
  UPSTREAM_REPO_URL,
} from '@constants/branding';

import cx from '@hub/lib/cx';

interface Props {
  className?: string;
}

export function GlobalFooter(props: Props) {
  return (
    <footer
      className={cx(
        props.className,
        'flex',
        'flex-col',
        'items-center',
        'px-4',
      )}
    >
      <div className="text-sm text-neutral-900 text-center">
        Powered by Solana, Realms is a hub for communities to share ideas, make
        decisions, and collectively manage treasuries.
      </div>
      <div
        className={cx(
          'flex-col',
          'flex',
          'items-center',
          'justify-center',
          'text-neutral-700',
          'text-xs',
          'mt-2',
          'sm:flex-row',
          'sm:text-sm',
        )}
      >
        <div>{APP_NAME}</div>
        <div className="hidden sm:block mx-2">|</div>
        <a href={UPSTREAM_REPO_URL} target="_blank" rel="noreferrer">
          {UPSTREAM_ATTRIBUTION}
        </a>
      </div>
    </footer>
  );
}
