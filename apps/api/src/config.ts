export function readConfig(env: NodeJS.ProcessEnv = process.env): {
  host: string;
  port: number;
  webOrigin: string;
} {
  const port = Number(env.PORT ?? '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  const webOrigin = env.WEB_ORIGIN ?? 'http://localhost:3000';
  const parsedOrigin = new URL(webOrigin);
  if (
    !['http:', 'https:'].includes(parsedOrigin.protocol) ||
    parsedOrigin.origin !== webOrigin
  ) {
    throw new Error('WEB_ORIGIN must be an HTTP(S) origin without a path or trailing slash.');
  }

  return { host: env.HOST ?? '0.0.0.0', port, webOrigin };
}
