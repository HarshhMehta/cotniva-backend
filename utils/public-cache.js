/** Safe Cache-Control for public read-only GET responses */
const PUBLIC_LISTING_CACHE =
  "public, max-age=60, s-maxage=60, stale-while-revalidate=300";

const PUBLIC_SETTINGS_CACHE =
  "public, max-age=60, s-maxage=60, stale-while-revalidate=300";

const setPublicCache = (res, value = PUBLIC_LISTING_CACHE) => {
  if (res && typeof res.set === "function") {
    res.set("Cache-Control", value);
  }
};

const PRIVATE_NO_STORE = "private, no-store, max-age=0";

const setPrivateNoStore = (res) => {
  if (res && typeof res.set === "function") {
    res.set("Cache-Control", PRIVATE_NO_STORE);
  }
};

module.exports = {
  PUBLIC_LISTING_CACHE,
  PUBLIC_SETTINGS_CACHE,
  PRIVATE_NO_STORE,
  setPublicCache,
  setPrivateNoStore,
};
