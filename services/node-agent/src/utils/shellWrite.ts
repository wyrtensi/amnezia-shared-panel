/**
 * Построить безопасную команду атомарной записи файла внутри shell
 */
export const buildWriteFileCommand = (
  path: string,
  content: string,
): string => {
  const encoded = Buffer.from(content, "utf-8").toString("base64");
  const tmpPath = `${path}.tmp`;

  return (
    `echo '${encoded}' | base64 -d > '${tmpPath}' && ` +
    `mv -f '${tmpPath}' '${path}'`
  );
};

/**
 * Build an atomic, validated, and durable WireGuard config replacement.
 */
export const buildValidatedWgConfigCommand = (
  path: string,
  content: string,
  stripBinary: "wg-quick" | "awg-quick",
): string => {
  const encoded = Buffer.from(content, "utf-8").toString("base64");
  const lastSlash = path.lastIndexOf("/");
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash) : ".";
  const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const interfaceName = filename.endsWith(".conf")
    ? filename.slice(0, -".conf".length)
    : filename;
  const tmpPath = `${directory}/.${interfaceName}.tmp.conf`;

  return (
    `{ echo '${encoded}' | base64 -d > '${tmpPath}' && ` +
    `sync && ` +
    `${stripBinary} strip '${tmpPath}' > /dev/null && ` +
    `mv -f '${tmpPath}' '${path}' && ` +
    `sync; } || { rm -f '${tmpPath}'; exit 1; }`
  );
};
