import { useEffect, useState } from "preact/hooks";

/** The SPA's URL: links inside the app change it without a page load. */

const CHANGE = "popstate";

export const navigate = (href: string) => {
  history.pushState(null, "", href);
  dispatchEvent(new PopStateEvent(CHANGE));
};

export const useUrl = () => {
  const [url, setUrl] = useState(() => new URL(location.href));
  useEffect(() => {
    const update = () => setUrl(new URL(location.href));
    addEventListener(CHANGE, update);
    return () => removeEventListener(CHANGE, update);
  }, []);
  return url;
};

/** A click on an in-app link navigates in the SPA; other links and modified clicks work as usual. */
export const followLink = (event: MouseEvent) => {
  const link =
    event.target instanceof Element ? event.target.closest("a") : null;
  if (
    link === null ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    link.target !== "" ||
    link.origin !== location.origin
  ) {
    return;
  }
  event.preventDefault();
  navigate(link.pathname + link.search);
};
