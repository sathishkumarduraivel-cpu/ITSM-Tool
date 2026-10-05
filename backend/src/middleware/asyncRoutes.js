// Express 4 does not understand a rejected promise.
//
// When an `async (req, res) => {...}` handler throws, Express 4 never sees
// it: the rejection becomes a process-level unhandledRejection, the error
// middleware never runs, and nothing ever writes a response. The client sits
// there until its own timeout. `process.on('unhandledRejection')` in index.js
// logs it, but a log cannot answer an HTTP request.
//
// This walks the mounted app once, after every route is registered, and wraps
// each async handler so its rejection is forwarded to next() -- which is
// exactly what Express does for a synchronous throw, so the existing error
// handler produces the same 500 it always would.
//
// Done here, in one place, rather than by hand at ~37 call sites: handlers
// added later are covered automatically, and there is no chance of a file
// being missed or a wrapper being dropped during a refactor.

const isAsync = (fn) => typeof fn === 'function'
  // Native async functions report this constructor name. Checked rather than
  // wrapping everything, so ordinary synchronous handlers keep their exact
  // behaviour (including throwing straight into Express as they do now).
  && (fn.constructor?.name === 'AsyncFunction');

function wrap(fn) {
  // Arity matters: Express decides whether a function is an error handler by
  // its length (4 args), so the wrapper has to present the same shape.
  if (fn.length >= 4) {
    const wrapped = (err, req, res, next) => Promise.resolve(fn(err, req, res, next)).catch(next);
    Object.defineProperty(wrapped, 'name', { value: fn.name || 'asyncErrorHandler' });
    return wrapped;
  }
  const wrapped = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  Object.defineProperty(wrapped, 'name', { value: fn.name || 'asyncHandler' });
  return wrapped;
}

function protectLayer(layer, stats, seen) {
  // A route layer: its own stack holds the handlers for each method.
  if (layer.route?.stack) {
    for (const h of layer.route.stack) {
      if (isAsync(h.handle)) {
        h.handle = wrap(h.handle);
        stats.wrapped += 1;
      } else {
        stats.skipped += 1;
      }
    }
    return;
  }
  // A mounted router or sub-app: recurse into it.
  const nested = layer.handle?.stack;
  if (Array.isArray(nested)) {
    protectStack(nested, stats, seen);
    return;
  }
  // Plain middleware mounted with app.use / router.use.
  if (isAsync(layer.handle)) {
    layer.handle = wrap(layer.handle);
    stats.wrapped += 1;
  }
}

function protectStack(stack, stats, seen) {
  // The same router can be mounted more than once; wrapping it twice would
  // be harmless but the count would lie, so each stack is visited once.
  if (seen.has(stack)) return;
  seen.add(stack);
  for (const layer of stack) protectLayer(layer, stats, seen);
}

/**
 * Wrap every async handler reachable from this app or router.
 *
 * Call it AFTER all routes are mounted and BEFORE the error handler matters;
 * returns what it did so startup can say so out loud.
 */
export function protectAsyncRoutes(appOrRouter) {
  const stack = appOrRouter?._router?.stack || appOrRouter?.stack || appOrRouter?.router?.stack;
  const stats = { wrapped: 0, skipped: 0 };
  if (!Array.isArray(stack)) return stats;
  protectStack(stack, stats, new Set());
  return stats;
}

export default protectAsyncRoutes;
