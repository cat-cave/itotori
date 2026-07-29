export function applyMutation(source, mutation) {
  const parts = source.split(mutation.find);
  const occurrences = parts.length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `mutation '${mutation.id}': expected exactly 1 occurrence of find token in ${mutation.file}, found ${occurrences}`,
    );
  }
  return parts.join(mutation.replace);
}

export function classifyOutcome({ status, output }) {
  const compileError =
    /error\[E\d{2,4}\]/u.test(output) ||
    /error: could not compile/u.test(output) ||
    /error: linking with/u.test(output) ||
    /error: aborting due to/u.test(output) ||
    /error: expected `.+`, found /u.test(output) ||
    /error: cannot find (?:value|type|function|macro|crate|trait) /u.test(output);
  if (compileError) return "compile_error";
  if (status === 0) return "escaped";
  return "killed";
}
