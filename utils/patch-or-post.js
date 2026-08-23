/**
 * cPanel / LiteSpeed ModSecurity often blocks PATCH before Node runs.
 * Register the same handler for PATCH and POST on admin mutation routes.
 */
function bindPatchOrPost(router) {
  return (path, ...handlers) => {
    router.patch(path, ...handlers);
    router.post(path, ...handlers);
  };
}

module.exports = { bindPatchOrPost };
