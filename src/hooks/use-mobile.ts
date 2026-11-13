import * as React from "react"

const MOBILE_BREAKPOINT = 768

const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

export function useIsMobile() {
  // useSyncExternalStore keeps the media-query state outside render-phase
  // effects (hydration-safe: the server snapshot is fixed at false).
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  )
}
