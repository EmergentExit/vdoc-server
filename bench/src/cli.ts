/** `--name value` from the command line; `--flag` alone reads as "true". */
export function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? 'true' : value;
}
