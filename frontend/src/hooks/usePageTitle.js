import { useEffect } from 'react';

// Lets a detail page (a specific ticket, HR case, workflow...) own the
// browser tab title once its own data has loaded, overriding whatever
// AppShell's route-based default set on navigation -- AppShell only ever
// sets a title for its own known static routes (see its NAV_GROUPS-derived
// map), so it never fights this hook for a route like /tickets/:id that
// isn't in that map to begin with. Pass a falsy title (e.g. before a fetch
// resolves) to skip -- the tab keeps whatever it already said rather than
// flashing a "Loading…" title into browser history.
export function usePageTitle(title) {
  useEffect(() => {
    if (!title) return undefined;
    document.title = `${title} · ITSM AI`;
  }, [title]);
}
