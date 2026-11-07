/**
 * KITE SYSTEM — Module contract
 * Every page module is registered through defineModule(). The contract is explicit and checked once, at startup:
 *
 *   id           route id (lower-case letters / digits / dash)
 *   title        shown while loading and in errors
 *   breadcrumbs  optional array of crumbs (plain text; the router escapes them)
 *   create(app)  returns a page instance (one per visit)
 *   instance.render(container, query, scope)  draws the page into `container`; everything it listens to goes through `scope`
 *   instance.dispose()                        optional: release anything that is not managed by the scope
 *
 * The router calls dispose() and then scope.dispose() when the user leaves, and ignores a render that finished
 * after the user had already moved on.
 */
export function defineModule(def) {
  const problems = [];
  if (!def || typeof def !== 'object') throw new Error('Module contract: a definition object is required');
  if (typeof def.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(def.id)) problems.push('id must be a lower-case route id');
  if (typeof def.title !== 'string' || !def.title.trim()) problems.push('title is required');
  if (typeof def.create !== 'function') problems.push('create(app) is required');
  if (def.breadcrumbs !== undefined && !Array.isArray(def.breadcrumbs)) problems.push('breadcrumbs must be an array');
  if (problems.length) throw new Error(`Module contract "${def?.id ?? '?'}": ${problems.join('; ')}`);
  return Object.freeze({ breadcrumbs: [def.title], ...def });
}

/** Checks a freshly created page instance; throws a readable error instead of a TypeError at render time. */
export function assertInstance(id, instance) {
  if (!instance || typeof instance.render !== 'function') throw new Error(`Module "${id}" did not return an instance with render(container, query, scope)`);
  if (instance.dispose !== undefined && typeof instance.dispose !== 'function') throw new Error(`Module "${id}": dispose must be a function`);
  return instance;
}
