import { runCli } from './cli-impl.js';
import { log } from './logger.js';

runCli().then(
  (code) => {
    if (typeof code === 'number') process.exit(code);
  },
  (err: Error) => {
    log.error(err.stack ?? err.message ?? String(err));
    process.exit(1);
  },
);
