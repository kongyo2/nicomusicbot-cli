export function shouldUseHeadlessMode(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
): boolean {
  return stdin.isTTY !== true || stdout.isTTY !== true;
}
