function rawStringEnd(input, start) {
  const opening = /^r(#+)?"/u.exec(input.slice(start));
  if (!opening) return undefined;
  const terminator = `"${opening[1] ?? ""}`;
  const end = input.indexOf(terminator, start + opening[0].length);
  return end < 0 ? undefined : end + terminator.length - 1;
}

function masked(input) {
  return input.replace(/[^\r\n]/g, " ");
}

function rustCodeMask(input) {
  let output = "";
  let blockDepth = 0;
  let lineComment = false;
  let quote;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        output += character;
      } else {
        output += " ";
      }
      continue;
    }
    if (blockDepth > 0) {
      if (character === "/" && next === "*") {
        blockDepth += 1;
        output += "  ";
        index += 1;
      } else if (character === "*" && next === "/") {
        blockDepth -= 1;
        output += "  ";
        index += 1;
      } else {
        output += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (quote) {
      output += character === "\n" || character === "\r" ? character : " ";
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    const rawEnd = rawStringEnd(input, index);
    if (rawEnd !== undefined) {
      output += masked(input.slice(index, rawEnd + 1));
      index = rawEnd;
      continue;
    }
    if (character === '"') {
      quote = character;
      output += " ";
      continue;
    }
    if (character === "/" && next === "*") {
      blockDepth = 1;
      output += "  ";
      index += 1;
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function findRustAttributeEnd(contents, openBracket) {
  let depth = 1;
  for (let index = openBracket + 1; index < contents.length; index += 1) {
    if (contents[index] === "[") {
      depth += 1;
    } else if (contents[index] === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function splitTopLevelArguments(input) {
  const arguments_ = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === "(") {
      depth += 1;
    } else if (input[index] === ")") {
      depth -= 1;
    } else if (input[index] === "," && depth === 0) {
      arguments_.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  arguments_.push(input.slice(start).trim());
  return arguments_;
}

function isIgnoredRustAttribute(attribute) {
  const trimmed = attribute.trim();
  if (/^(?:r#)?ignore(?:\s*=|\s*$)/u.test(trimmed)) return true;
  const open = trimmed.indexOf("(");
  if (!/^(?:r#)?cfg_attr\s*\(/u.test(trimmed) || !trimmed.endsWith(")") || open < 0) {
    return false;
  }
  return splitTopLevelArguments(trimmed.slice(open + 1, -1))
    .slice(1)
    .some((nested) => isIgnoredRustAttribute(nested));
}

function hasAttributeBoundary(code, closeBracket) {
  const next = code.slice(closeBracket + 1).trimStart()[0];
  return next === undefined || next === "#" || next === ";" || /[A-Za-z_]/u.test(next);
}

/** Return source offsets for every direct or conditional Rust ignore attribute. */
export function findRustIgnoreAttributes(contents) {
  const code = rustCodeMask(contents);
  const locations = [];
  for (const match of code.matchAll(/#\s*\[/gu)) {
    const offset = match.index ?? 0;
    const openBracket = code.indexOf("[", offset);
    const closeBracket = findRustAttributeEnd(code, openBracket);
    if (
      closeBracket !== undefined &&
      hasAttributeBoundary(code, closeBracket) &&
      isIgnoredRustAttribute(code.slice(openBracket + 1, closeBracket))
    ) {
      locations.push(offset);
    }
  }
  return locations;
}
