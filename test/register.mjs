// Lets `node --test` load the TypeScript sources directly: Node strips the types, and this
// maps the `.js` specifiers the sources use (for tsc's output) to the `.ts` files on disk.
import { register } from 'node:module';

register(
  'data:text/javascript,' + encodeURIComponent(`
    import { existsSync } from 'node:fs';
    import { fileURLToPath } from 'node:url';
    export async function resolve(specifier, context, next) {
      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
        const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
        if (existsSync(fileURLToPath(ts))) return next(ts.href, context);
      }
      return next(specifier, context);
    }
  `),
  import.meta.url,
);
