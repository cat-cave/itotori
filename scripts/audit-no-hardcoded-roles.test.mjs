// auth-006-no-hardcoded-roles-guard — regression suite facade for the
// AST-based no-hardcoded-roles CI guard (auth-noroles-guard-ast).
//
// Keep this original entrypoint so every existing runner command continues to
// register the complete suite. The focused modules below own its test groups.
import "./audit-no-hardcoded-roles-shapes.test.mjs";
import "./audit-no-hardcoded-roles-ast-edges.test.mjs";
import "./audit-no-hardcoded-roles-cli.test.mjs";
