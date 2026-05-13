import { parse } from "@babel/parser";
import type { ParserOptions } from "@babel/parser";
import type {
  ClassDeclaration,
  ClassMethod,
  File,
  Node,
  StringLiteral,
} from "@babel/types";
import { toCamelCase } from "./utils";

const PARSE_OPTS: ParserOptions = {
  sourceType: "module",
  allowImportExportEverywhere: true,
  allowReturnOutsideFunction: true,
  errorRecovery: true,
  plugins: ["typescript", "jsx", "decorators-legacy"],
};

function sliceSource(source: string, start: number, end: number): string {
  return source.slice(start, end);
}

function memberKeyFromRelativeImport(specifier: string): string | null {
  const m = specifier.match(/^\.\/(?:models|namespaces)\/([^./]+)\.js$/);
  if (!m?.[1]) return null;
  return toCamelCase(m[1]);
}

function nodeReferencesRemoved(
  source: string,
  node: Node,
  removedIds: Set<string>
): boolean {
  if (node.start == null || node.end == null) return false;
  const slice = sliceSource(source, node.start, node.end);
  for (const id of removedIds) {
    const re = new RegExp(
      `\\b${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
    );
    if (re.test(slice)) return true;
  }
  return false;
}

function rewriteConstructor(
  source: string,
  member: ClassMethod,
  removedIds: Set<string>
): string | null {
  const body = member.body;
  const keptStmts: string[] = [];
  for (const stmt of body.body) {
    if (nodeReferencesRemoved(source, stmt, removedIds)) continue;
    keptStmts.push(sliceSource(source, stmt.start!, stmt.end!));
  }
  if (keptStmts.length === 0) return null;
  const open = sliceSource(source, member.start!, body.start! + 1);
  const close = sliceSource(source, body.end!, member.end!);
  return `${open}${keptStmts.join("\n")}${close}`;
}

function rewriteClassMember(
  source: string,
  member: ClassDeclaration["body"]["body"][number],
  removedIds: Set<string>
): string | null {
  if (member.type === "ClassMethod" && member.kind === "constructor") {
    return rewriteConstructor(source, member, removedIds);
  }
  if (nodeReferencesRemoved(source, member, removedIds)) return null;
  return sliceSource(source, member.start!, member.end!);
}

function rewriteClassDeclaration(
  source: string,
  classNode: ClassDeclaration,
  removedIds: Set<string>
): string {
  const bodyKept: string[] = [];
  for (const member of classNode.body.body) {
    const rewritten = rewriteClassMember(source, member, removedIds);
    if (rewritten) bodyKept.push(rewritten);
  }
  const open = sliceSource(source, classNode.start!, classNode.body.start! + 1);
  const close = sliceSource(source, classNode.body.end!, classNode.end!);
  const inner = bodyKept.map((s) => s.trimEnd()).filter(Boolean).join("\n");
  return inner ? `${open}${inner}${close}` : `${open}${close}`;
}

/**
 * Strip model/namespace imports (and class members that reference them) from
 * Gadget `Client.js` surfaces. Extensions bundle `Client.js` directly, so the
 * entry barrel rewrite alone is not enough — unused `./models/*.js` imports
 * must be removed before those files are deleted from disk.
 */
export function rewriteGadgetClientSource(
  source: string,
  keepCamelMembers: Set<string>
): { ok: true; code: string } | { ok: false } {
  let ast: File;
  try {
    ast = parse(source, PARSE_OPTS) as File;
  } catch {
    return { ok: false };
  }

  const removedIds = new Set<string>();
  const kept: string[] = [];

  for (const stmt of ast.program.body) {
    if (stmt.type === "ImportDeclaration") {
      const src = (stmt.source as StringLiteral).value;
      const memberKey = memberKeyFromRelativeImport(src);
      if (memberKey !== null && !keepCamelMembers.has(memberKey)) {
        for (const spec of stmt.specifiers) {
          if (spec.type === "ImportSpecifier" && spec.local.type === "Identifier") {
            removedIds.add(spec.local.name);
          }
        }
        continue;
      }
      kept.push(sliceSource(source, stmt.start!, stmt.end!));
      continue;
    }

    if (stmt.type === "ClassDeclaration") {
      kept.push(rewriteClassDeclaration(source, stmt, removedIds));
      continue;
    }

    if (
      stmt.type === "ExportNamedDeclaration" &&
      stmt.declaration?.type === "ClassDeclaration"
    ) {
      const prefix = sliceSource(source, stmt.start!, stmt.declaration.start!);
      const suffix = sliceSource(source, stmt.declaration.end!, stmt.end!);
      kept.push(
        prefix +
          rewriteClassDeclaration(source, stmt.declaration, removedIds) +
          suffix
      );
      continue;
    }

    if (stmt.type === "ExportDefaultDeclaration") {
      const decl = stmt.declaration;
      if (decl.type === "ClassDeclaration") {
        const prefix = sliceSource(source, stmt.start!, decl.start!);
        const suffix = sliceSource(source, decl.end!, stmt.end!);
        kept.push(
          prefix + rewriteClassDeclaration(source, decl, removedIds) + suffix
        );
        continue;
      }
    }

    if (nodeReferencesRemoved(source, stmt, removedIds)) continue;
    kept.push(sliceSource(source, stmt.start!, stmt.end!));
  }

  const code = kept
    .map((s) => s.trimEnd())
    .filter(Boolean)
    .join("\n");
  return { ok: true, code: code ? `${code}\n` : "" };
}
